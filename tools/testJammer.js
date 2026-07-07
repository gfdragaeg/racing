/**
 * tools/testJammer.js
 * ------------------------------------------------------------------
 * Headless integration test for the GPS Jammer, exercising the REAL
 * server code (Game + Abilities), not a re-implementation.
 *
 *   1. Weighted-pickup rarity: grantRandomAbility should hand out the
 *      jammer only rarely (~2-3% of crates).
 *   2. Targeting: firing the jammer locks onto the position-1 racer
 *      and applies fxJam; a holder who is ALREADY 1st just fizzles.
 *   3. Effect: an fxJam'd car's simulated top speed is ~20% lower.
 *
 * Run:  node tools/testJammer.js
 */

import { Game } from '../server/game/Game.js';
import { useAbility, grantRandomAbility } from '../server/game/Abilities.js';
import { stepVehicle, makeVehicleState } from '../shared/physics.js';
import { buildTrack, collideWithTrack, terrainModsAt } from '../shared/tracks.js';
import { PHYS, JAM_SPEED_MUL } from '../shared/constants.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

/* A minimal room + io stub so we can build a real Game with 3 bots. */
const ioStub = { to: () => ({ emit: () => {} }) };
const room = {
  code: 'TEST', players: new Map(),
  settings: { mode: 'combat', map: 'downtown', laps: 2, health: 100, rate: 'normal', bots: 3, private: false },
};
const game = new Game(ioStub, room, () => {});
game.pushEvent = () => {}; // swallow events for the test

/* --- 1. rarity ---------------------------------------------------- */
const N = 60000;
const counts = {};
const victim = [...game.players.values()][0];
for (let i = 0; i < N; i++) {
  victim.ability = null;
  grantRandomAbility(game, victim);
  counts[victim.ability] = (counts[victim.ability] || 0) + 1;
}
const jamPct = (counts.jammer / N) * 100;
check('GPS Jammer is a rare pickup', jamPct > 1 && jamPct < 5, `${jamPct.toFixed(2)}% of crates`);
check('every ability can still roll', Object.keys(counts).length >= 13, `${Object.keys(counts).length} distinct`);

/* --- 2. targeting the leader ------------------------------------- */
const racers = [...game.players.values()];
// Give them distinct progress so position 1 is unambiguous.
racers.forEach((r, i) => { r.score = 3 - i; });
game.updatePositions();
const leader = racers.find((r) => r.position === 1);
const trailer = racers.find((r) => r.position === 3);

trailer.ability = 'jammer';
useAbility(game, trailer);
check('jammer locks onto 1st place', leader.fxJam > 4.9, `leader fxJam=${leader.fxJam.toFixed(2)}s`);
check('jammer consumed on use', trailer.ability === null);
check('non-leaders untouched', racers.find((r) => r.position === 2).fxJam === 0);

/* holder already in 1st -> fizzle (no self-jam) */
leader.fxJam = 0;
leader.ability = 'jammer';
useAbility(game, leader);
check('leader firing jammer does not self-jam', leader.fxJam === 0);

/* --- 3. the 20% top-speed effect --------------------------------- */
const track = buildTrack('downtown');
const runTopSpeed = (jam) => {
  const s = makeVehicleState();
  const w = track.worldAt(0.5, 0);
  s.x = w.x; s.z = w.z; s.h = Math.atan2(w.dirX, w.dirZ);
  const input = { th: 1, st: 0, drift: false, boost: false, jump: false, fire: false };
  for (let t = 0; t < 300; t++) {       // 10 s at 30 Hz -> terminal velocity
    if (jam) s.fxJam = 1;                // keep it jammed the whole run
    const mods = terrainModsAt(track, s);
    if (s.fxJam > 0) mods.maxMul *= JAM_SPEED_MUL;
    stepVehicle(s, input, 1 / 30, mods);
    collideWithTrack(track, s, 1 / 30);
  }
  return Math.hypot(s.vx, s.vz);
};
const vNormal = runTopSpeed(false);
const vJammed = runTopSpeed(true);
const ratio = vJammed / vNormal;
check('jammed top speed ~20% lower', ratio > 0.76 && ratio < 0.84,
  `normal=${vNormal.toFixed(1)} jammed=${vJammed.toFixed(1)} (${(ratio * 100).toFixed(0)}%)`);

game.destroy();
console.log(failures === 0 ? '\nALL JAMMER TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
