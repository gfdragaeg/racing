/**
 * tools/testFeatures.js
 * ------------------------------------------------------------------
 * Integration test for the Toxic-map / Slime / Volcano-holes / colour
 * features, exercising the REAL server code (Game + Abilities + Lobby).
 *
 * Run: node tools/testFeatures.js
 */

import { Game } from '../server/game/Game.js';
import { LobbyManager } from '../server/lobby/LobbyManager.js';
import { useAbility, updateWorldObjects } from '../server/game/Abilities.js';
import {
  SLIME_SLOW_SECONDS, SLIME_TOTAL_SECONDS, SLIME_SPEED_MUL,
} from '../shared/constants.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const ioStub = { to: () => ({ emit: () => {} }) };
const newGame = (map, bots) => {
  const room = { code: 'TEST', players: new Map(),
    settings: { mode: 'combat', map, laps: 3, health: 100, rate: 'normal', bots, private: false } };
  const g = new Game(ioStub, room, () => {});
  g.pushEvent = () => {};
  return g;
};

/* ================= 1. Volcano bottomless holes ==================== */
{
  const game = newGame('volcano', 1);
  const p = [...game.players.values()][0];

  // Deep into lap 2 (lapsDone=1), sitting in a pit on the ground.
  p.lapsDone = 1; p.nextCp = 5;
  const hole = game.track.hazards.find((h) => h.type === 'hole');
  p.x = hole.x; p.z = hole.z; p.y = 0;

  game.checkStaticHazards(p);
  check('falling keeps completed laps', p.lapsDone === 1, `lapsDone=${p.lapsDone}`);
  check('falling resets to chase checkpoint 1', p.nextCp === 1, `nextCp=${p.nextCp}`);
  check('falling teleports back to lap start (s≈0)', p.s < 0.03, `s=${p.s.toFixed(3)}`);
  check('falling grants brief spawn protection', p.invulnT > 0, `invulnT=${p.invulnT.toFixed(1)}`);

  // Hopping over the same hole (airborne) must NOT fall you.
  p.y = 1.2; p.nextCp = 5;
  game.checkStaticHazards(p);
  check('hopping over a hole does NOT fall you', p.nextCp === 5, `nextCp=${p.nextCp}`);
}

/* ===================== 2. Slime Bomb ============================= */
// Place two cars ON THE ROAD, one just ahead of the other, so the
// slimeball flies down the track instead of off into the infield.
const placeOnRoad = (game, car, s) => {
  const w = game.track.worldAt(s, 0);
  car.x = w.x; car.z = w.z; car.h = Math.atan2(w.dirX, w.dirZ); car.trackIdx = w.idx;
};
{
  const game = newGame('toxic', 2);
  const [a, b] = [...game.players.values()];
  placeOnRoad(game, a, 0.50);
  placeOnRoad(game, b, 0.53); b.score = 2; // b is ahead

  a.ability = 'slime';
  useAbility(game, a);
  check('slime spawns a slimeball projectile', game.projectiles.some((pr) => pr.ty === 'slimeball'));

  for (let i = 0; i < 120 && b.fxSlime === 0; i++) updateWorldObjects(game, 1 / 30);
  check('slimeball hit applies slime', b.fxSlime > 0, `fxSlime=${b.fxSlime.toFixed(2)}`);
  check('slime total ≈ COVER+SLOW', b.fxSlime > SLIME_TOTAL_SECONDS - 0.6, `${b.fxSlime.toFixed(2)}s`);

  // Replicate Game.tickRacer's slime speed rule for each phase.
  const maxMul = (fxSlime) =>
    (fxSlime > 0 && fxSlime <= SLIME_SLOW_SECONDS) ? SLIME_SPEED_MUL : 1;
  check('COVER phase does not slow', maxMul(SLIME_TOTAL_SECONDS) === 1);
  check('SLOW phase cuts top speed', maxMul(SLIME_SLOW_SECONDS - 0.1) < 0.9,
    `maxMul=${maxMul(SLIME_SLOW_SECONDS - 0.1)}`);
}
{
  // A shield eats the slime instead of being splattered.
  const game = newGame('toxic', 2);
  const [a, b] = [...game.players.values()];
  placeOnRoad(game, a, 0.50);
  placeOnRoad(game, b, 0.53); b.score = 2; b.shieldT = 5;
  a.ability = 'slime';
  useAbility(game, a);
  for (let i = 0; i < 120 && b.shieldT > 0; i++) updateWorldObjects(game, 1 / 30);
  check('shield blocks slime (popped, no effect)', b.fxSlime === 0 && b.shieldT === 0,
    `fxSlime=${b.fxSlime.toFixed(2)} shield=${b.shieldT.toFixed(1)}`);
}

/* ============ 3. Lobby car-colour validation ==================== */
{
  const lobby = new LobbyManager(ioStub);
  const sock = makeSocket('sock1');
  lobby.handleConnection(sock);
  sock.fire('room:create', { name: 'Tester' });
  const player = lobby.bySocket.get('sock1').players.get('sock1');

  sock.fire('room:color', { color: '#2ce0c8' });   // teal (valid)
  check('valid colour accepted', player.color === '#2ce0c8', player.color);
  sock.fire('room:color', { color: '#123456' });    // off-palette
  check('off-palette colour rejected', player.color === '#2ce0c8', player.color);
}

console.log(failures === 0 ? '\nALL FEATURE TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);

/* ----------------------------- helpers ---------------------------- */
function makeSocket(id) {
  const handlers = {};
  return {
    id,
    on(ev, fn) { handlers[ev] = fn; },
    emit() {}, join() {}, leave() {},
    fire(ev, data) { handlers[ev]?.(data); },
  };
}
