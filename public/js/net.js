/**
 * public/js/net.js
 * ------------------------------------------------------------------
 * Thin wrapper around the Socket.IO connection. Keeps every network
 * concern in one module so the rest of the client never touches the
 * raw socket. All game traffic is:
 *   outbound  – lobby actions + race inputs only (server authoritative)
 *   inbound   – room state, race snapshots, race lifecycle events
 */

/* global io */

class Network {
  constructor() {
    this.socket = io();
    this.handlers = new Map();

    // Fan incoming events out to registered handlers.
    const forward = (event) =>
      this.socket.on(event, (data) => this.handlers.get(event)?.forEach((fn) => fn(data)));

    for (const ev of [
      'connect', 'disconnect', 'room:state', 'room:error', 'room:backToLobby',
      'race:start', 'race:snapshot', 'race:finished', 'voice:signal',
    ]) forward(ev);
  }

  /** Register a handler for a server event (multiple allowed). */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  emit(event, data) { this.socket.emit(event, data); }

  /** Our own socket id (identifies us in room state and snapshots). */
  get id() { return this.socket.id; }
  get connected() { return this.socket.connected; }
}

export const net = new Network();
