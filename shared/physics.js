/**
 * shared/physics.js
 * ------------------------------------------------------------------
 * The arcade vehicle simulation, shared by server and client.
 *
 * The SERVER is authoritative: it runs stepVehicle() for every car at
 * a fixed 30 Hz using the latest input received from each player.
 *
 * The CLIENT runs the exact same function for its OWN car only
 * (client-side prediction). When a snapshot arrives, the client
 * rewinds to the server state and replays its not-yet-acknowledged
 * inputs, so local driving feels instant while the server stays in
 * charge. Remote cars are simply interpolated between snapshots.
 *
 * Vehicle state fields used here (a plain object on both sides):
 *   x, z, y       position (y = height above road, 0 = grounded)
 *   vx, vz, vy    velocity
 *   h             heading (radians, 0 faces +Z)
 *   boostMeter    drift-earned boost resource (0..100)
 *   boostTime     seconds of active boost remaining
 *   fxSpin        seconds of oil-slick spin-out remaining
 *   fxFrozen      seconds of freeze-mine lockup remaining
 *   fxEmp         seconds of EMP engine-disable remaining
 */

import { PHYS, clamp, wrapAngle } from './constants.js';

/**
 * Advance one vehicle by `dt` seconds.
 *
 * @param {object} s     vehicle state (mutated in place)
 * @param {object} input { th, st, drift, boost, jump } where
 *                       th = throttle -1..1, st = steer -1..1,
 *                       drift/boost = held booleans, jump = edge boolean
 * @param {number} dt    timestep in seconds
 * @param {object} mods  { grip, accelMul, maxMul } situational modifiers
 *                       (surface grip, status effects)
 */
export function stepVehicle(s, input, dt, mods = {}) {
  const grip = mods.grip ?? 1;
  const spd = Math.hypot(s.vx, s.vz);

  const frozen = s.fxFrozen > 0;
  const spinning = s.fxSpin > 0;
  const emp = s.fxEmp > 0;
  const airborne = s.y > 0.05;

  // Status effects gate the controls, not the physics.
  let th = frozen || spinning ? 0 : clamp(input.th || 0, -1, 1);
  if (emp && th > 0) th = 0; // EMP kills the engine; brakes still work
  const st = frozen || spinning ? 0 : clamp(input.st || 0, -1, 1);
  const drifting = !!input.drift && !airborne && !frozen && !spinning && Math.abs(st) > 0.15 && spd > 8;

  // Decompose velocity into car-relative forward / lateral parts.
  const fx = Math.sin(s.h), fz = Math.cos(s.h);
  const rx = fz, rz = -fx; // right-hand vector
  let vF = s.vx * fx + s.vz * fz;
  let vL = s.vx * rx + s.vz * rz;

  const boosting = s.boostTime > 0;
  const maxSpd = PHYS.MAX_SPEED * (boosting ? PHYS.BOOST_MAXSPEED_MUL : 1) * (mods.maxMul ?? 1);
  const accel = PHYS.ENGINE_ACCEL * (boosting ? PHYS.BOOST_ACCEL_MUL : 1) * (mods.accelMul ?? 1);

  if (!airborne) {
    if (th > 0) {
      vF += accel * th * dt;
    } else if (th < 0) {
      if (vF > 0.5) vF += PHYS.BRAKE_DECEL * th * dt;            // braking
      else vF = Math.max(vF + accel * 0.6 * th * dt, -PHYS.REVERSE_MAX); // reversing
    }
    // Rolling drag, plus a soft ceiling that eases us back to max speed
    // (so boost pads can fling us over it without a hard clamp snap).
    vF -= vF * PHYS.DRAG * dt;
    if (vF > maxSpd) vF += (maxSpd - vF) * Math.min(1, 4 * dt);
    // Lateral grip: sideways velocity bleeds off; drifting/ice bleed less.
    const g = (drifting ? PHYS.DRIFT_GRIP : PHYS.GRIP) * grip;
    vL *= Math.exp(-g * dt);
  } else {
    vF -= vF * 0.05 * dt; // just air drag while airborne
  }

  // Steering. Effectiveness ramps up from standstill and gently falls
  // off with speed; reversed when driving backwards; reduced mid-air.
  if (spinning) {
    s.h = wrapAngle(s.h + PHYS.SPIN_RATE * dt);
  } else if (!frozen) {
    // The 0.35 floor lets cars rotate while barely moving — vital for
    // recovering after being wall-pinned or spun around.
    const eff = Math.min(1, 0.35 + spd / 7) / (1 + spd / PHYS.STEER_SPEED_FALLOFF);
    const dir = vF < -0.5 ? -1 : 1;
    const air = airborne ? 0.35 : 1;
    // Drifting used to sharpen the turn (1.5x) which felt twitchy; it now
    // gently WIDENS the turn (0.8x) so a drift is a smooth, controllable
    // slide rather than a snap-rotation. The looser DRIFT_GRIP still lets
    // the tail step out.
    s.h = wrapAngle(s.h + st * PHYS.STEER_RATE * (drifting ? 0.8 : 1) * eff * dir * air * dt);
  }

  if (frozen) { vF = 0; vL = 0; }

  // Recompose world velocity along the (possibly rotated) car axes —
  // this "velocity follows the nose" is the core of the arcade feel.
  const fx2 = Math.sin(s.h), fz2 = Math.cos(s.h);
  const rx2 = fz2, rz2 = -fx2;
  s.vx = fx2 * vF + rx2 * vL;
  s.vz = fz2 * vF + rz2 * vL;

  // Jump (a small kart-style hop; also initiates drifts).
  if (input.jump && !airborne && !frozen && !spinning) s.vy = PHYS.JUMP_VY;

  // Vertical motion.
  s.vy -= PHYS.GRAVITY * dt;
  s.y += s.vy * dt;
  if (s.y <= 0) { s.y = 0; s.vy = 0; }

  // Integrate position.
  s.x += s.vx * dt;
  s.z += s.vz * dt;

  // Boost meter economy: drift to earn, hold boost to spend.
  if (drifting) {
    s.boostMeter = Math.min(PHYS.BOOST_METER_MAX, s.boostMeter + PHYS.DRIFT_FILL_RATE * dt);
  }
  if (input.boost && s.boostMeter > 1 && !frozen && !spinning && !emp && !airborne) {
    s.boostMeter = Math.max(0, s.boostMeter - PHYS.BOOST_DRAIN_RATE * dt);
    s.boostTime = Math.max(s.boostTime, 0.18); // sustained while held
  }

  // Tick down status timers. (fxJam only trims top speed, applied via
  // mods.maxMul by the caller — it doesn't gate the controls here.)
  s.boostTime = Math.max(0, s.boostTime - dt);
  s.fxSpin = Math.max(0, s.fxSpin - dt);
  s.fxFrozen = Math.max(0, s.fxFrozen - dt);
  s.fxEmp = Math.max(0, s.fxEmp - dt);
  s.fxJam = Math.max(0, (s.fxJam || 0) - dt);
}

/** Blank vehicle state (spawned at a track spawn point by the caller). */
export function makeVehicleState() {
  return {
    x: 0, z: 0, y: 0,
    vx: 0, vz: 0, vy: 0,
    h: 0,
    boostMeter: 0, boostTime: 0,
    fxSpin: 0, fxFrozen: 0, fxEmp: 0, fxJam: 0,
    trackIdx: null,
    wallHit: false,
  };
}

/** Copy just the fields stepVehicle cares about (used by prediction). */
export function copyVehicleState(dst, src) {
  dst.x = src.x; dst.z = src.z; dst.y = src.y;
  dst.vx = src.vx; dst.vz = src.vz; dst.vy = src.vy;
  dst.h = src.h;
  dst.boostMeter = src.boostMeter; dst.boostTime = src.boostTime;
  dst.fxSpin = src.fxSpin; dst.fxFrozen = src.fxFrozen; dst.fxEmp = src.fxEmp;
  dst.fxJam = src.fxJam;
  return dst;
}
