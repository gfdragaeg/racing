/**
 * tools/testClient.js
 * ------------------------------------------------------------------
 * Headless Socket.IO client for multiplayer testing without a second
 * browser. It joins a room by code, readies up, and once the race
 * starts it drives using the same look-ahead steering the server bots
 * use — but crucially it goes through the full HUMAN network path
 * (inputs -> server -> snapshots), which exercises input handling,
 * acks and lap logic end to end.
 *
 * Usage:  node tools/testClient.js <ROOMCODE> [name]
 */

import { io } from 'socket.io-client';
import { buildTrack } from '../shared/tracks.js';
import { wrapAngle, clamp } from '../shared/constants.js';

const code = process.argv[2];
const name = process.argv[3] || 'TestDummy';
if (!code) {
  console.error('usage: node tools/testClient.js <ROOMCODE> [name]');
  process.exit(1);
}

const URL = process.env.GAME_URL || 'http://localhost:3000';
const socket = io(URL);

let track = null;
let myState = null; // our car as last seen in a snapshot
let seq = 0;
let trackIdx = 0;

socket.on('connect', () => {
  console.log(`[test] connected as ${socket.id}, joining ${code}`);
  socket.emit('room:join', { code, name });
});

socket.on('room:error', (e) => {
  console.error('[test] room error:', e.message);
  process.exit(1);
});

socket.on('room:state', (state) => {
  const me = state.players.find((p) => p.id === socket.id);
  if (me && !me.ready && state.state === 'lobby') {
    socket.emit('room:ready', { ready: true });
    console.log(`[test] in lobby ${state.code} with ${state.players.length} player(s); readied up`);
  }
});

socket.on('race:start', (payload) => {
  console.log(`[test] race starting on ${payload.track}`);
  track = buildTrack(payload.track);
  socket.emit('race:loaded');
});

socket.on('race:snapshot', (sn) => {
  const me = sn.players.find((p) => p.id === socket.id);
  if (me) myState = me;
  for (const ev of sn.ev) {
    if (ev.e === 'lap' && ev.id === socket.id) console.log(`[test] completed lap ${ev.lap}`);
    if (ev.e === 'finish' && ev.id === socket.id) console.log('[test] FINISHED!');
  }
});

socket.on('race:finished', ({ results }) => {
  console.log('[test] race over. results:');
  for (const r of results) {
    console.log(`  ${r.position}. ${r.name} ${r.finished ? '' : '(DNF)'} dealt=${r.damageDealt} taken=${r.damageTaken}`);
  }
});

// Drive at 30 Hz with simple look-ahead steering along the centreline.
setInterval(() => {
  if (!track || !myState || myState.dead || myState.fin) return;

  // Find the nearest sample (coarse scan is fine at this scale).
  const pts = track.pts;
  let best = 1e18;
  for (let i = 0; i < pts.length; i++) {
    const dx = myState.x - pts[i].x, dz = myState.z - pts[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; trackIdx = i; }
  }
  const spd = Math.hypot(myState.vx, myState.vz);
  const aim = pts[(trackIdx + 10 + Math.floor(spd * 0.4)) % pts.length];
  const want = Math.atan2(aim.x - myState.x, aim.z - myState.z);
  const diff = wrapAngle(want - myState.h);

  seq++;
  socket.emit('race:input', {
    seq,
    th: Math.abs(diff) > 1.2 ? 0.2 : 0.9,
    st: clamp(diff * 2.5, -1, 1),
    drift: false, boost: false, jump: false,
    fire: !!myState.ab && Math.random() < 0.05, // fire abilities sometimes
  });
}, 1000 / 30);
