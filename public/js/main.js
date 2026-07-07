/**
 * public/js/main.js
 * ------------------------------------------------------------------
 * Application shell: screen routing and all menu / lobby / results
 * UI wiring. Gameplay itself lives in game/GameClient.js; this file
 * only decides which screen is visible and shuttles UI events to the
 * network layer.
 */

import { net } from './net.js';
import { GameClient } from './game/GameClient.js';
import { audio } from './audio/AudioManager.js';
import { VoiceChat } from './voice/VoiceChat.js';
import { TRACK_INFO } from '/shared/tracks.js';
import { CAR_COLORS } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

/* ================================================================== *
 *  Screen router
 * ================================================================== */

const SCREENS = ['menu', 'play', 'settings', 'credits', 'lobby', 'game', 'results'];
let current = 'menu';

function show(name) {
  current = name;
  for (const s of SCREENS) $(`screen-${s}`).classList.toggle('active', s === name);
}

/* ================================================================== *
 *  App state
 * ================================================================== */

const game = new GameClient(net);
// Voice chat is architecture-only for now (see voice/VoiceChat.js).
// eslint-disable-next-line no-unused-vars
const voice = new VoiceChat(net);

let room = null;      // latest room:state
let lastResults = null;

const playerName = () => $('name-input').value.trim() || 'Racer';

// Persist the racer name across sessions.
$('name-input').value = localStorage.getItem('cc-name') || '';
$('name-input').addEventListener('input', () => localStorage.setItem('cc-name', $('name-input').value));

// The AudioContext can only start after a user gesture.
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

// Touch-device detection drives the on-screen controls (body.touch in
// CSS). A one-shot keydown listener flips it back off if a real
// keyboard turns out to be present (hybrid laptops report coarse
// pointers), so those players get the cleaner keyboard HUD.
if (window.matchMedia('(pointer: coarse)').matches ||
    'ontouchstart' in window || navigator.maxTouchPoints > 0) {
  document.body.classList.add('touch');
  window.addEventListener('keydown', (e) => {
    // Any driving key press means there's a keyboard: hide touch UI.
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.code)) {
      document.body.classList.remove('touch');
    }
  }, { once: true });
}

/* ================================================================== *
 *  Main menu / play / settings / credits
 * ================================================================== */

$('btn-play').onclick = () => { $('play-error').textContent = ''; show('play'); };
$('btn-settings').onclick = () => show('settings');
$('btn-credits').onclick = () => show('credits');
$('btn-quit').onclick = () => {
  // Browsers only allow window.close() for script-opened windows.
  window.close();
  setTimeout(() => alert('Thanks for playing! You can close this tab now.'), 50);
};
$('btn-play-back').onclick = () => show('menu');
$('btn-settings-back').onclick = () => show('menu');
$('btn-credits-back').onclick = () => show('menu');

$('btn-create').onclick = () => net.emit('room:create', { name: playerName() });
$('btn-join').onclick = joinRoom;
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
function joinRoom() {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length < 5) { $('play-error').textContent = 'Enter the 5-character room code.'; return; }
  net.emit('room:join', { code, name: playerName() });
}

// Volume sliders drive the AudioManager directly.
for (const [id, kind] of [['vol-master', 'master'], ['vol-sfx', 'sfx'], ['vol-engine', 'engine']]) {
  const el = $(id);
  el.value = Math.round((audio.volumes[kind] ?? 0.8) * 100);
  el.addEventListener('input', () => audio.setVolume(kind, el.value / 100));
}

/* ================================================================== *
 *  Lobby
 * ================================================================== */

const SETTING_IDS = ['mode', 'map', 'laps', 'health', 'rate', 'bots'];

function renderLobby() {
  if (!room) return;
  const me = room.players.find((p) => p.id === net.id);
  const isHost = room.hostId === net.id;

  $('lobby-code').textContent = room.code;

  // Player list with ready states. Your own colour dot is clickable and
  // cycles to the next car colour (the swatch row below picks a specific
  // one).
  $('lobby-players').innerHTML = room.players.map((p) => `
    <li>
      <span class="dot ${p.id === net.id ? 'clickable' : ''}" data-me="${p.id === net.id}"
        style="background:${p.color}" ${p.id === net.id ? 'title="Click to change your car colour"' : ''}></span>
      <span class="who">${escapeHtml(p.name)}${p.id === net.id ? ' (you)' : ''}
        ${p.isHost ? '<span class="tag">★ HOST</span>' : ''}</span>
      <span class="rdy ${p.ready || p.isHost ? 'on' : ''}">${p.isHost ? 'HOST' : p.ready ? 'READY' : 'waiting'}</span>
    </li>`).join('');
  // Clicking your own dot cycles colour.
  const myDot = $('lobby-players').querySelector('.dot[data-me="true"]');
  if (myDot) myDot.onclick = cycleMyColor;

  renderColorSwatches(me?.color);

  // Settings: host edits, everyone else views.
  for (const key of SETTING_IDS) {
    const el = $(`set-${key}`);
    el.value = String(room.settings[key]);
    el.disabled = !isHost;
  }
  $('set-private').checked = room.settings.private;
  $('set-private').disabled = !isHost;
  $('lobby-host-note').textContent = isHost ? '(you are the host)' : '(host controls these)';
  $('map-blurb').textContent =
    `${TRACK_INFO[room.settings.map].difficulty} — ${TRACK_INFO[room.settings.map].blurb}`;

  // Ready + start buttons.
  const allReady = room.players.every((p) => p.ready || p.id === room.hostId);
  $('btn-ready').classList.toggle('ready-on', !!me?.ready);
  $('btn-ready').textContent = me?.ready ? 'READY ✓' : 'READY UP';
  $('btn-ready').style.display = isHost ? 'none' : '';
  $('btn-start').style.display = isHost ? '' : 'none';
  $('btn-start').disabled = !allReady;
  $('lobby-status').textContent = isHost
    ? (allReady ? 'All set — start when ready!' : 'Waiting for players to ready up…')
    : 'Waiting for the host to start the race…';
}

/** Render the 8 car-colour swatches, highlighting the current pick. */
function renderColorSwatches(currentHex) {
  const wrap = $('color-swatches');
  if (!wrap) return;
  wrap.innerHTML = CAR_COLORS.map((c) => `
    <button class="swatch ${c.hex === currentHex ? 'selected' : ''}"
      data-hex="${c.hex}" style="background:${c.hex}" title="${c.name}"
      aria-label="${c.name}"></button>`).join('');
  wrap.querySelectorAll('.swatch').forEach((btn) => {
    btn.onclick = () => net.emit('room:color', { color: btn.dataset.hex });
  });
}

/** Clicking your own dot advances to the next colour in the palette. */
function cycleMyColor() {
  const me = room?.players.find((p) => p.id === net.id);
  if (!me) return;
  const idx = CAR_COLORS.findIndex((c) => c.hex === me.color);
  const next = CAR_COLORS[(idx + 1) % CAR_COLORS.length];
  net.emit('room:color', { color: next.hex });
}

$('btn-ready').onclick = () => {
  const me = room?.players.find((p) => p.id === net.id);
  net.emit('room:ready', { ready: !me?.ready });
};
$('btn-start').onclick = () => net.emit('room:start');
$('btn-leave').onclick = leaveRoom;
$('lobby-code').onclick = () => navigator.clipboard?.writeText(room?.code ?? '');

for (const key of SETTING_IDS) {
  $(`set-${key}`).addEventListener('change', (e) => net.emit('room:settings', { [key]: e.target.value }));
}
$('set-private').addEventListener('change', (e) => net.emit('room:settings', { private: e.target.checked }));

function leaveRoom() {
  net.emit('room:leave');
  room = null;
  game.dispose();
  show('menu');
}

/* ================================================================== *
 *  In-game pause menu
 * ================================================================== */

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && current === 'game') togglePause();
});
function togglePause() {
  const menu = $('pause-menu');
  const paused = menu.classList.toggle('hidden');
  game.paused = !paused;
}
$('btn-resume').onclick = togglePause;
// On-screen pause button (touch devices).
$('touch-pause').onclick = () => { if (current === 'game') togglePause(); };
$('btn-pause-leave').onclick = () => {
  $('pause-menu').classList.add('hidden');
  game.paused = false;
  leaveRoom();
};

/* ================================================================== *
 *  Results
 * ================================================================== */

function fmtMs(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${s}` : `${s}s`;
}

function renderResults() {
  if (!lastResults) return;
  const { results, fastestLap } = lastResults;
  const medals = ['🥇', '🥈', '🥉'];
  const isHost = room?.hostId === net.id;

  $('results-fastest').textContent = fastestLap
    ? `⚡ Fastest lap: ${fastestLap.name} — ${fmtMs(fastestLap.ms)}`
    : '';

  $('results-table').querySelector('tbody').innerHTML = results.map((r) => `
    <tr class="${r.id === net.id ? 'me' : ''}">
      <td class="medal">${medals[r.position - 1] ?? r.position}</td>
      <td class="racer" style="color:${r.color}">${escapeHtml(r.name)}${r.isBot ? ' 🤖' : ''}</td>
      <td>${r.finished ? fmtMs(r.timeMs) : `DNF (lap ${r.laps + 1})`}</td>
      <td>${fmtMs(r.bestLapMs)}</td>
      <td>${r.damageDealt}</td>
      <td>${r.damageTaken}</td>
      <td>${r.abilitiesUsed}</td>
    </tr>`).join('');

  $('btn-rematch').style.display = isHost ? '' : 'none';
  $('btn-return-lobby').style.display = isHost ? '' : 'none';
  $('results-wait').textContent = isHost ? '' : 'Waiting for the host to pick rematch or lobby…';

  const mine = results.find((r) => r.id === net.id);
  $('results-title').textContent = mine
    ? (mine.position === 1 ? '🏆 VICTORY!' : `You finished ${ordinal(mine.position)}`)
    : 'Race complete';
}

$('btn-rematch').onclick = () => net.emit('room:rematch');
$('btn-return-lobby').onclick = () => net.emit('room:toLobby');
$('btn-results-leave').onclick = leaveRoom;

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ================================================================== *
 *  Network events
 * ================================================================== */

net.on('connect', () => { $('conn-status').textContent = 'online'; });
net.on('disconnect', () => {
  $('conn-status').textContent = 'connection lost — reconnecting…';
  if (current !== 'menu') {
    room = null;
    game.dispose();
    show('menu');
  }
});

net.on('room:state', (state) => {
  room = state;
  // First room:state after create/join moves us into the lobby.
  if (current === 'play' || (current === 'menu' && state.players.some((p) => p.id === net.id))) {
    show('lobby');
  }
  if (current === 'lobby') renderLobby();
  if (current === 'results') renderResults(); // host may have changed
});

net.on('room:error', ({ message }) => {
  if (current === 'play') $('play-error').textContent = message;
  else if (current === 'lobby') $('lobby-status').textContent = `⚠ ${message}`;
});

net.on('room:backToLobby', () => {
  game.end();
  show('lobby');
  renderLobby();
});

net.on('race:start', (payload) => {
  $('pause-menu').classList.add('hidden');
  show('game');
  game.begin(payload);
});

net.on('race:snapshot', (sn) => game.onSnapshot(sn));

net.on('race:finished', (data) => {
  lastResults = data;
  game.end();
  show('results');
  renderResults();
});

/* ================================================================== */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

show('menu');

// Debug handle for console/testing sessions (not used by game code).
window.__cc = { game, net };
