/**
 * server/game/Bots.js
 * ------------------------------------------------------------------
 * Server-side bot driver. Bots are ordinary racers whose input comes
 * from this function instead of a socket, so every other system
 * (physics, abilities, damage, laps) treats them identically to
 * humans. The same brain also autopilots finished human cars.
 *
 * Strategy: chase a look-ahead point on the track centreline, brake
 * for upcoming curvature, occasionally fire whatever ability is held.
 */

import { wrapAngle, clamp } from '../../shared/constants.js';

/**
 * Compute one tick of input for a bot racer.
 * @returns {{th:number, st:number, drift:boolean, boost:boolean, jump:boolean, fire:boolean}}
 */
export function computeBotInput(game, p) {
  const track = game.track;
  const pts = track.pts;
  const n = pts.length;
  const spd = Math.hypot(p.vx, p.vz);
  const skill = p.botSkill ?? 0.9;

  // Make sure we know where we are on the track.
  if (p.trackIdx == null) p.trackIdx = 0;

  // Look-ahead scales with speed: faster bots aim further down the road.
  const look = 9 + Math.floor(spd * 0.55);
  const aimIdx = (p.trackIdx + look) % n;
  const aim = pts[aimIdx];

  // Racing line: bias the aim toward the INSIDE of the upcoming corner
  // so bots cut apexes instead of hugging the centreline. The corner's
  // direction of turn tells us which edge is the inside.
  const far = pts[(p.trackIdx + look * 2) % n];
  const want = Math.atan2(aim.x - p.x, aim.z - p.z);
  const want2 = Math.atan2(far.x - aim.x, far.z - aim.z);
  const turn = wrapAngle(want2 - want);           // signed: + left, - right
  const curve = Math.abs(turn);
  const inside = Math.sign(turn) || 1;
  const rx = aim.dirZ, rz = -aim.dirX;             // road right-hand normal
  const lineOff = clamp(curve * 9, 0, track.halfWidth * 0.7) * -inside;
  const tx = aim.x + rx * lineOff;
  const tz = aim.z + rz * lineOff;

  const diff = wrapAngle(Math.atan2(tx - p.x, tz - p.z) - p.h);
  const st = clamp(diff * 2.6, -1, 1);

  // Throttle: lift/brake proportionally to how sharp the corner is and
  // how badly we're off-line, but never brake so hard we crawl.
  let th = skill;
  if (curve > 0.35 && spd > 21) th = 0.55;         // lift for a bend
  if (curve > 0.7 && spd > 17) th = 0.15;          // ease for a tight one
  if (curve > 1.1 && spd > 15) th = -0.25;         // gentle brake, hairpin
  if (Math.abs(diff) > 1.4 && spd > 12) th = -0.3; // badly off line: scrub

  // Drift through sharp, fast corners to hold the line and fill the
  // boost meter; spend that boost on straights when we're pointed right.
  const drift = curve > 0.5 && spd > 14 && Math.abs(st) > 0.4;
  const boost = !drift && curve < 0.18 && Math.abs(diff) < 0.25 &&
    p.boostMeter > 35 && spd > 12;

  // Fire the held ability. Bots now aim: they hold fire until roughly
  // lined up behind a target (for the straight-shot weapons) or just
  // periodically for the area/trap weapons.
  let fire = false;
  if (p.ability && game.phase === 'racing') {
    p.botFireT = (p.botFireT || 0) + 1 / 30;
    if (p.botFireT > 0.8) {
      const aimed = STRAIGHT_SHOT.has(p.ability);
      const target = aimed ? nearestAhead(game, p) : null;
      const lined = target
        ? Math.abs(wrapAngle(Math.atan2(target.x - p.x, target.z - p.z) - p.h)) < 0.3
        : true;
      // Higher-skill bots fire more decisively.
      if (lined && Math.random() < 0.05 + skill * 0.05) {
        fire = true;
        p.botFireT = 0;
      }
    }
  }

  return { th, st, drift, boost, jump: false, fire };
}

/** Abilities that fire straight ahead and want a lined-up shot. */
const STRAIGHT_SHOT = new Set(['rail', 'minigun', 'bouncer', 'rocket']);

/** Nearest living opponent roughly in front of the bot, else nearest. */
function nearestAhead(game, p) {
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  let best = null, bestD = Infinity;
  for (const q of game.players.values()) {
    if (q === p || q.dead || q.finished) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    if (dx * fx + dz * fz < 0) continue; // behind us
    const d = Math.hypot(dx, dz);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}
