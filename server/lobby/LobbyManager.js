/**
 * server/lobby/LobbyManager.js
 * ------------------------------------------------------------------
 * Owns every room on the server and routes all socket traffic.
 *
 * Responsibilities:
 *  - create rooms with unguessable 5-character codes
 *  - join / leave / ready flow, host migration
 *  - host-only settings changes (validated against SETTING_OPTIONS)
 *  - starting races (hands off to server/game/Game.js)
 *  - blocking joins once a race has begun
 *  - relaying WebRTC signalling blobs for the FUTURE proximity voice
 *    chat feature (see public/js/voice/VoiceChat.js) — the transport
 *    is wired up now so voice can be added without protocol changes.
 */

import {
  MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_OPTIONS, PLAYER_COLORS, CAR_COLOR_HEXES,
} from '../../shared/constants.js';
import { Game } from '../game/Game.js';

/** Characters used in room codes (no 0/O/1/I ambiguity). */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;

export class LobbyManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, Room>} code -> room */
    this.rooms = new Map();
    /** @type {Map<string, Room>} socket.id -> room the socket is in */
    this.bySocket = new Map();
  }

  /* ------------------------------------------------------------ *
   *  Socket wiring
   * ------------------------------------------------------------ */

  handleConnection(socket) {
    socket.on('room:create', (data) => this.createRoom(socket, data));
    socket.on('room:join', (data) => this.joinRoom(socket, data));
    socket.on('room:leave', () => this.leaveRoom(socket));
    socket.on('room:ready', (data) => this.setReady(socket, data));
    socket.on('room:color', (data) => this.setColor(socket, data));
    socket.on('room:settings', (data) => this.changeSettings(socket, data));
    socket.on('room:start', () => this.startRace(socket));
    socket.on('room:rematch', () => this.rematch(socket));
    socket.on('room:toLobby', () => this.returnToLobby(socket));

    socket.on('race:input', (data) => {
      const room = this.bySocket.get(socket.id);
      room?.game?.setInput(socket.id, data);
    });
    socket.on('race:loaded', () => {
      const room = this.bySocket.get(socket.id);
      room?.game?.markLoaded(socket.id);
    });

    // Voice-chat signalling relay (future WebRTC proximity chat).
    // Blobs are opaque to the server; we only forward within the room.
    socket.on('voice:signal', ({ to, payload } = {}) => {
      const room = this.bySocket.get(socket.id);
      if (room && room.players.has(to)) {
        this.io.to(to).emit('voice:signal', { from: socket.id, payload });
      }
    });

    socket.on('disconnect', () => this.leaveRoom(socket));
  }

  /* ------------------------------------------------------------ *
   *  Room lifecycle
   * ------------------------------------------------------------ */

  generateCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(socket, { name } = {}) {
    this.leaveRoom(socket); // a socket can only be in one room
    const code = this.generateCode();
    const room = {
      code,
      hostId: socket.id,
      state: 'lobby', // 'lobby' | 'racing' | 'post'
      settings: { ...DEFAULT_SETTINGS },
      /** @type {Map<string, object>} socket.id -> lobby player */
      players: new Map(),
      game: null,
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, name);
    console.log(`[room ${code}] created by ${socket.id}`);
  }

  joinRoom(socket, { code, name } = {}) {
    code = String(code || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
    if (room.state !== 'lobby') return socket.emit('room:error', { message: 'That race has already started.' });
    if (room.players.size >= MAX_PLAYERS) return socket.emit('room:error', { message: 'Room is full (8 players max).' });
    this.leaveRoom(socket);
    this.addPlayer(room, socket, name);
    console.log(`[room ${code}] ${socket.id} joined (${room.players.size} players)`);
  }

  addPlayer(room, socket, name) {
    // Assign the lowest free grid slot; slot also decides car colour.
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;

    const clean = String(name || '').trim().slice(0, 16) || `Racer-${slot + 1}`;
    room.players.set(socket.id, {
      id: socket.id,
      name: clean,
      slot,
      color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
      ready: false,
    });
    this.bySocket.set(socket.id, room);
    socket.join(room.code);
    this.broadcastState(room);
  }

  leaveRoom(socket) {
    const room = this.bySocket.get(socket.id);
    if (!room) return;

    this.bySocket.delete(socket.id);
    room.players.delete(socket.id);
    socket.leave(room.code);
    room.game?.removePlayer(socket.id);

    if (room.players.size === 0) {
      // Empty room: tear everything down.
      room.game?.destroy();
      this.rooms.delete(room.code);
      console.log(`[room ${room.code}] closed (empty)`);
      return;
    }
    // Host migration: promote the longest-standing member.
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
      console.log(`[room ${room.code}] host migrated to ${room.hostId}`);
    }
    this.broadcastState(room);
  }

  /* ------------------------------------------------------------ *
   *  Lobby actions
   * ------------------------------------------------------------ */

  setReady(socket, { ready } = {}) {
    const room = this.bySocket.get(socket.id);
    const p = room?.players.get(socket.id);
    if (!p || room.state !== 'lobby') return;
    p.ready = !!ready;
    this.broadcastState(room);
  }

  /** A player picks their car colour from the validated palette. */
  setColor(socket, { color } = {}) {
    const room = this.bySocket.get(socket.id);
    const p = room?.players.get(socket.id);
    if (!p || room.state !== 'lobby') return;
    if (!CAR_COLOR_HEXES.includes(color)) return; // reject anything off-palette
    p.color = color;
    this.broadcastState(room);
  }

  changeSettings(socket, patch = {}) {
    const room = this.bySocket.get(socket.id);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;

    const s = room.settings;
    // Whitelist + validate every field individually.
    if (SETTING_OPTIONS.mode.includes(patch.mode)) s.mode = patch.mode;
    if (SETTING_OPTIONS.map.includes(patch.map)) s.map = patch.map;
    if (SETTING_OPTIONS.laps.includes(Number(patch.laps))) s.laps = Number(patch.laps);
    if (SETTING_OPTIONS.health.includes(Number(patch.health))) s.health = Number(patch.health);
    if (SETTING_OPTIONS.rate.includes(patch.rate)) s.rate = patch.rate;
    if (SETTING_OPTIONS.bots.includes(Number(patch.bots))) s.bots = Number(patch.bots);
    if (typeof patch.private === 'boolean') s.private = patch.private;
    this.broadcastState(room);
  }

  startRace(socket) {
    const room = this.bySocket.get(socket.id);
    if (!room || room.hostId !== socket.id || room.state === 'racing') return;

    // Everyone except the host must have readied up.
    const notReady = [...room.players.values()].filter((p) => p.id !== room.hostId && !p.ready);
    if (notReady.length > 0) {
      return socket.emit('room:error', { message: 'All players must ready up first.' });
    }
    this.launchGame(room);
  }

  launchGame(room) {
    room.game?.destroy();
    room.state = 'racing';
    room.game = new Game(this.io, room, () => {
      // Called by the game when the race fully ends.
      room.state = 'post';
      this.broadcastState(room);
    });
    room.game.start();
    this.broadcastState(room);
    console.log(`[room ${room.code}] race started on ${room.settings.map}`);
  }

  /** Host requests an instant rematch with the same settings. */
  rematch(socket) {
    const room = this.bySocket.get(socket.id);
    if (!room || room.hostId !== socket.id || room.state !== 'post') return;
    this.launchGame(room);
  }

  /** Host sends everyone back to the lobby after a race. */
  returnToLobby(socket) {
    const room = this.bySocket.get(socket.id);
    if (!room || room.hostId !== socket.id || room.state !== 'post') return;
    room.game?.destroy();
    room.game = null;
    room.state = 'lobby';
    for (const p of room.players.values()) p.ready = false;
    this.io.to(room.code).emit('room:backToLobby');
    this.broadcastState(room);
  }

  /* ------------------------------------------------------------ *
   *  State broadcast
   * ------------------------------------------------------------ */

  broadcastState(room) {
    this.io.to(room.code).emit('room:state', {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      settings: room.settings,
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, color: p.color,
        ready: p.ready, isHost: p.id === room.hostId,
      })),
    });
  }
}
