/**
 * server/game/Abilities.js
 * ------------------------------------------------------------------
 * Server-authoritative implementation of every ability, plus shared
 * damage handling. Nothing here ever runs on the client: clients only
 * see the results via snapshots (projectile positions, ground items)
 * and one-shot events (beams, blasts, hits) they turn into VFX/SFX.
 *
 * Damage numbers follow the design brief and live in
 * shared/constants.js (ABILITIES) where they are easy to balance.
 */

import {
  ABILITIES, ABILITY_IDS, ABILITY_WEIGHTS, JAM_SECONDS, SLIME_TOTAL_SECONDS,
  PHYS, wrapAngle,
} from '../../shared/constants.js';
import { trackLocate, inOpenZone } from '../../shared/tracks.js';

/* ================================================================== *
 *  Damage & status effects
 * ================================================================== */

/**
 * Apply damage to a racer, respecting spawn protection and shields.
 * `attackerId` (nullable) gets damage-dealt credit for the scoreboard.
 */
export function applyDamage(game, target, amount, attackerId, opts = {}) {
  if (target.dead || target.finished) return;
  if (target.invulnT > 0) return;

  // A shield eats the whole hit (only "real" hits, not env ticks).
  if (target.shieldT > 0 && !opts.silent) {
    target.shieldT = 0;
    game.pushEvent({ e: 'shieldPop', id: target.id });
    return;
  }

  target.hp -= amount;
  target.stats.taken += amount;
  const attacker = attackerId ? game.players.get(attackerId) : null;
  if (attacker && attacker !== target) attacker.stats.dealt += amount;

  if (!opts.silent) game.pushEvent({ e: 'hit', id: target.id, dmg: Math.round(amount) });
  if (target.hp <= 0) game.explode(target, attackerId);
}

/**
 * Apply a control-impairing status effect (spin / freeze / EMP),
 * which shields also block.
 */
function applyStatus(game, target, field, seconds, eventName) {
  if (target.dead || target.finished || target.invulnT > 0) return;
  if (target.shieldT > 0) {
    target.shieldT = 0;
    game.pushEvent({ e: 'shieldPop', id: target.id });
    return;
  }
  target[field] = Math.max(target[field], seconds);
  game.pushEvent({ e: eventName, id: target.id });
}

/** Radial explosion: damage + knockback to everyone except the owner. */
function explosion(game, x, z, radius, damage, ownerId) {
  game.pushEvent({ e: 'boom', x, z, r: radius });
  for (const p of game.players.values()) {
    if (p.id === ownerId || p.dead) continue;
    const dx = p.x - x, dz = p.z - z;
    const d = Math.hypot(dx, dz);
    if (d > radius) continue;
    const falloff = 1 - (d / radius) * 0.5; // 100% centre -> 50% edge
    applyDamage(game, p, damage * falloff, ownerId);
    // Knockback away from the blast.
    const k = 16 * falloff;
    p.vx += (dx / (d || 1)) * k;
    p.vz += (dz / (d || 1)) * k;
  }
}

/* ================================================================== *
 *  Pickup crates
 * ================================================================== */

/** Give a racer a weighted-random ability from the catalogue. */
export function grantRandomAbility(game, p) {
  p.ability = pickWeightedAbility();
  game.pushEvent({ e: 'pickup', id: p.id, ab: p.ability });
}

/** Roll one ability id, honouring ABILITY_WEIGHTS (default weight 1). */
function pickWeightedAbility() {
  let total = 0;
  for (const id of ABILITY_IDS) total += ABILITY_WEIGHTS[id] ?? 1;
  let r = Math.random() * total;
  for (const id of ABILITY_IDS) {
    r -= ABILITY_WEIGHTS[id] ?? 1;
    if (r <= 0) return id;
  }
  return ABILITY_IDS[0];
}

/* ================================================================== *
 *  Ability activation
 * ================================================================== */

/** Fire the racer's held ability. Consumes it. */
export function useAbility(game, p) {
  const ab = p.ability;
  if (!ab) return;
  p.ability = null;
  p.stats.used++;
  game.pushEvent({ e: 'use', id: p.id, ab });

  switch (ab) {
    case 'rocket': fireRocket(game, p); break;
    case 'rail': fireRailgun(game, p); break;
    case 'emp': fireEmp(game, p); break;
    case 'shock': fireShockwave(game, p); break;
    case 'chain': fireChainLightning(game, p); break;
    case 'cluster': fireClusterBomb(game, p); break;
    case 'oil': dropGroundItem(game, p, 'oil', 12); break;
    case 'mine': dropGroundItem(game, p, 'mine', 25); break;
    case 'fire': p.fireTrailT = 3; p.fireDropT = 0; break;
    case 'shield': p.shieldT = 12; break;
    case 'nitro': p.boostTime = Math.max(p.boostTime, 2.6); break;
    case 'minigun': p.gunT = 1.6; p.gunCd = 0; break; // fires from Game.tick
    case 'bouncer': fireBouncer(game, p); break;
    case 'jammer': fireJammer(game, p); break;
    case 'slime': fireSlime(game, p); break;
  }
}

/**
 * GPS Jammer: auto-locks onto whoever is currently in 1st place and
 * scrambles their electronics — top speed cut (applied via fxJam in
 * Game.tickRacer) for JAM_SECONDS, plus a screen glitch on the victim.
 * As a catch-up item it simply fizzles if the holder is already the
 * leader (no self-jam). Shields and spawn protection block it.
 */
function fireJammer(game, p) {
  let leader = null;
  for (const q of game.players.values()) {
    if (q.position === 1) { leader = q; break; }
  }
  if (!leader || leader === p) {
    // Nobody ahead to jam — you're already winning.
    game.pushEvent({ e: 'jamFizzle', id: p.id });
    return;
  }
  if (leader.dead || leader.finished || leader.invulnT > 0) return;
  if (leader.shieldT > 0) {
    leader.shieldT = 0;
    game.pushEvent({ e: 'shieldPop', id: leader.id });
    return;
  }
  leader.fxJam = Math.max(leader.fxJam, JAM_SECONDS);
  game.pushEvent({ e: 'jam', id: leader.id, by: p.id });
}

/**
 * Slime Bomb: lob a blob of toxic slime forward. It homes gently toward
 * the nearest opponent ahead and, on contact, splatters their screen
 * (see fxSlime handling in Game.tickRacer / GameClient). Reuses the
 * projectile system; the slimeball itself does no impact damage.
 */
function fireSlime(game, p) {
  const target = pickTarget(game, p, { aheadOnly: true }) || pickTarget(game, p);
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  game.projectiles.push({
    id: game.nextObjectId++, ty: 'slimeball', owner: p.id,
    x: p.x + fx * 2.5, z: p.z + fz * 2.5, y: 1,
    h: p.h, speed: 46, t: 5,
    targetId: target?.id || null,
    trackIdx: p.trackIdx,
  });
}

/** Splatter a racer with slime (screen cover then slow). Shield/invuln block it. */
export function applySlime(game, target, ownerId) {
  if (target.dead || target.finished || target.invulnT > 0) return;
  if (target.shieldT > 0) {
    target.shieldT = 0;
    game.pushEvent({ e: 'shieldPop', id: target.id });
    return;
  }
  target.fxSlime = Math.max(target.fxSlime, SLIME_TOTAL_SECONDS);
  game.pushEvent({ e: 'slime', id: target.id, by: ownerId || null });
}

/**
 * One minigun bullet, called from the game tick while p.gunT > 0.
 * Short-range hitscan with a tracer event even on a miss, so the
 * burst is always visible.
 */
export function fireMinigunShot(game, p) {
  const RANGE = 35, WIDTH = 2.4;
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  let best = null, bestFwd = RANGE;
  for (const q of game.players.values()) {
    if (q === p || q.dead) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const fwd = dx * fx + dz * fz;
    if (fwd < 0 || fwd > RANGE) continue;
    if (Math.abs(dx * fz - dz * fx) > WIDTH) continue;
    if (fwd < bestFwd) { bestFwd = fwd; best = q; }
  }
  const endD = best ? bestFwd : RANGE;
  game.pushEvent({
    e: 'tracer',
    x1: p.x + fx * 2.2, z1: p.z + fz * 2.2,
    x2: p.x + fx * endD, z2: p.z + fz * endD,
  });
  if (best) {
    applyDamage(game, best, ABILITIES.minigun.damage, p.id);
    best.vx += fx * 1.5; best.vz += fz * 1.5;
  }
}

/** Bouncer: a heavy orb that ricochets off the track walls. */
function fireBouncer(game, p) {
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  game.projectiles.push({
    id: game.nextObjectId++, ty: 'bouncer', owner: p.id,
    x: p.x + fx * 2.6, z: p.z + fz * 2.6, y: 0.7,
    h: p.h, speed: 38, t: 8,
    trackIdx: p.trackIdx,
  });
}

/** Nearest living opponent, optionally only those ahead in the race. */
function pickTarget(game, p, { aheadOnly = false, maxDist = Infinity } = {}) {
  let best = null, bestD = maxDist;
  for (const q of game.players.values()) {
    if (q === p || q.dead || q.finished) continue;
    if (aheadOnly && q.score <= p.score) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

function fireRocket(game, p) {
  // Prefer someone ahead in the standings (classic combat-racer rule),
  // fall back to whoever is closest.
  const target = pickTarget(game, p, { aheadOnly: true }) || pickTarget(game, p);
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  game.projectiles.push({
    id: game.nextObjectId++, ty: 'rocket', owner: p.id,
    x: p.x + fx * 2.5, z: p.z + fz * 2.5, y: 1,
    h: p.h, speed: 55, t: 6,
    targetId: target?.id || null,
    trackIdx: p.trackIdx,
  });
}

function fireRailgun(game, p) {
  const RANGE = 90, WIDTH = 2.0;
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  // Hitscan: closest opponent inside the beam corridor takes the hit.
  let best = null, bestFwd = RANGE;
  for (const q of game.players.values()) {
    if (q === p || q.dead) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const fwd = dx * fx + dz * fz;
    if (fwd < 0 || fwd > RANGE) continue;
    const side = Math.abs(dx * fz - dz * fx);
    if (side > WIDTH) continue;
    if (fwd < bestFwd) { bestFwd = fwd; best = q; }
  }
  const endD = best ? bestFwd : RANGE;
  game.pushEvent({
    e: 'rail',
    x1: p.x, z1: p.z,
    x2: p.x + fx * endD, z2: p.z + fz * endD,
  });
  if (best) {
    applyDamage(game, best, ABILITIES.rail.damage, p.id);
    best.vx += fx * 10; best.vz += fz * 10; // slug knocks the target forward
  }
}

function fireEmp(game, p) {
  const RADIUS = 14;
  game.pushEvent({ e: 'empBlast', x: p.x, z: p.z, r: RADIUS });
  for (const q of game.players.values()) {
    if (q === p || q.dead) continue;
    if (Math.hypot(q.x - p.x, q.z - p.z) > RADIUS) continue;
    applyStatus(game, q, 'fxEmp', 2, 'empHit');
  }
}

function fireShockwave(game, p) {
  const RADIUS = 11;
  game.pushEvent({ e: 'shockwave', x: p.x, z: p.z, r: RADIUS });
  for (const q of game.players.values()) {
    if (q === p || q.dead) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > RADIUS) continue;
    applyDamage(game, q, ABILITIES.shock.damage, p.id);
    const k = 22 * (1 - d / RADIUS * 0.5);
    q.vx += (dx / (d || 1)) * k;
    q.vz += (dz / (d || 1)) * k;
    q.vy = Math.max(q.vy, 4); // pop them into the air a little
  }
}

function fireChainLightning(game, p) {
  const FIRST_RANGE = 22, CHAIN_RANGE = 14, MAX_HITS = 3;
  const hits = [];
  let from = p;
  for (let i = 0; i < MAX_HITS; i++) {
    const range = i === 0 ? FIRST_RANGE : CHAIN_RANGE;
    let best = null, bestD = range;
    for (const q of game.players.values()) {
      if (q === p || q.dead || hits.includes(q)) continue;
      const d = Math.hypot(q.x - from.x, q.z - from.z);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best) break;
    hits.push(best);
    from = best;
  }
  if (hits.length === 0) return;
  // Event carries the full zap path for the client's lightning VFX.
  game.pushEvent({
    e: 'chain',
    pts: [[p.x, p.z], ...hits.map((q) => [q.x, q.z])],
  });
  for (const q of hits) applyDamage(game, q, ABILITIES.chain.damage, p.id);
}

function fireClusterBomb(game, p) {
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  game.projectiles.push({
    id: game.nextObjectId++, ty: 'cluster', owner: p.id,
    x: p.x + fx * 2.5, z: p.z + fz * 2.5, y: 1.5,
    vx: p.vx + fx * 26, vz: p.vz + fz * 26, vy: 8,
    h: p.h, t: 3,
  });
}

/** Oil slicks and freeze mines drop just behind the car. */
function dropGroundItem(game, p, ty, life) {
  const fx = Math.sin(p.h), fz = Math.cos(p.h);
  game.groundItems.push({
    id: game.nextObjectId++, ty, owner: p.id,
    x: p.x - fx * 3, z: p.z - fz * 3,
    t: life, armT: 0.6, hitCd: new Map(),
  });
}

/* ================================================================== *
 *  Per-tick world object simulation (projectiles + ground items)
 * ================================================================== */

export function updateWorldObjects(game, dt) {
  updateProjectiles(game, dt);
  updateGroundItems(game, dt);
}

function updateProjectiles(game, dt) {
  const track = game.track;
  const spawned = [];

  game.projectiles = game.projectiles.filter((pr) => {
    pr.t -= dt;

    if (pr.ty === 'rocket') {
      // Home toward the target with a limited turn rate.
      const target = pr.targetId ? game.players.get(pr.targetId) : null;
      if (target && !target.dead) {
        const want = Math.atan2(target.x - pr.x, target.z - pr.z);
        const diff = wrapAngle(want - pr.h);
        const maxTurn = 3.2 * dt;
        pr.h = wrapAngle(pr.h + Math.max(-maxTurn, Math.min(maxTurn, diff)));
      }
      pr.x += Math.sin(pr.h) * pr.speed * dt;
      pr.z += Math.cos(pr.h) * pr.speed * dt;

      // Direct hit?
      for (const q of game.players.values()) {
        if (q.id === pr.owner || q.dead) continue;
        if (Math.hypot(q.x - pr.x, q.z - pr.z) < 2.2 && q.y < 2) {
          explosion(game, pr.x, pr.z, 4.5, ABILITIES.rocket.damage, pr.owner);
          return false;
        }
      }
      // Wall hit? (rockets do not fly over buildings/cliffs)
      const loc = trackLocate(track, pr.x, pr.z, pr.trackIdx);
      pr.trackIdx = loc.idx;
      if (Math.abs(loc.lat) > track.halfWidth + 0.5 && !inOpenZone(track, pr.x, pr.z)) {
        explosion(game, pr.x, pr.z, 4.5, ABILITIES.rocket.damage, pr.owner);
        return false;
      }
      if (pr.t <= 0) {
        explosion(game, pr.x, pr.z, 4.5, ABILITIES.rocket.damage, pr.owner);
        return false;
      }
      return true;
    }

    if (pr.ty === 'slimeball') {
      // Gently homing lob; splatters the first opponent it touches.
      const target = pr.targetId ? game.players.get(pr.targetId) : null;
      if (target && !target.dead) {
        const want = Math.atan2(target.x - pr.x, target.z - pr.z);
        const diff = wrapAngle(want - pr.h);
        const maxTurn = 2.2 * dt;
        pr.h = wrapAngle(pr.h + Math.max(-maxTurn, Math.min(maxTurn, diff)));
      }
      pr.x += Math.sin(pr.h) * pr.speed * dt;
      pr.z += Math.cos(pr.h) * pr.speed * dt;
      for (const q of game.players.values()) {
        if (q.id === pr.owner || q.dead) continue;
        if (Math.hypot(q.x - pr.x, q.z - pr.z) < 2.4 && q.y < 2) {
          applySlime(game, q, pr.owner);
          return false;
        }
      }
      // Splat harmlessly on the wall or when it times out.
      const sloc = trackLocate(track, pr.x, pr.z, pr.trackIdx);
      pr.trackIdx = sloc.idx;
      if ((Math.abs(sloc.lat) > track.halfWidth + 0.5 && !inOpenZone(track, pr.x, pr.z)) || pr.t <= 0) {
        game.pushEvent({ e: 'slimeSplat', x: pr.x, z: pr.z });
        return false;
      }
      return true;
    }

    if (pr.ty === 'cluster') {
      // Ballistic lob; bursts into bomblets on landing (or timeout).
      pr.vy -= PHYS.GRAVITY * dt;
      pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.y += pr.vy * dt;
      if (pr.y <= 0 || pr.t <= 0) {
        explosion(game, pr.x, pr.z, 3.5, 15, pr.owner);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
          spawned.push({
            id: game.nextObjectId++, ty: 'bomblet', owner: pr.owner,
            x: pr.x, z: pr.z, y: 1,
            vx: Math.sin(a) * (7 + Math.random() * 5),
            vz: Math.cos(a) * (7 + Math.random() * 5),
            vy: 7 + Math.random() * 3,
            h: a, t: 3,
          });
        }
        return false;
      }
      return true;
    }

    if (pr.ty === 'bouncer') {
      pr.x += Math.sin(pr.h) * pr.speed * dt;
      pr.z += Math.cos(pr.h) * pr.speed * dt;

      const loc = trackLocate(track, pr.x, pr.z, pr.trackIdx);
      pr.trackIdx = loc.idx;
      const lim = track.halfWidth - 0.8;
      if (Math.abs(loc.lat) > lim && !inOpenZone(track, pr.x, pr.z)) {
        // Reflect the travel direction across the wall and snap back in.
        const rx = loc.dirZ, rz = -loc.dirX;
        const vx = Math.sin(pr.h), vz = Math.cos(pr.h);
        const vlat = vx * rx + vz * rz;
        pr.h = Math.atan2(vx - 2 * vlat * rx, vz - 2 * vlat * rz);
        const sign = Math.sign(loc.lat);
        pr.x = loc.px + rx * sign * lim;
        pr.z = loc.pz + rz * sign * lim;
      } else if (Math.abs(loc.lat) > track.halfWidth * 4) {
        return false; // escaped through a shortcut into the wilderness
      }

      for (const q of game.players.values()) {
        if (q.dead || q.y > 1.2) continue;
        // The owner gets 0.6 s of grace so it can't detonate on launch.
        if (q.id === pr.owner && pr.t > 7.4) continue;
        if (Math.hypot(q.x - pr.x, q.z - pr.z) < 2.1) {
          explosion(game, pr.x, pr.z, 3, ABILITIES.bouncer.damage, q.id === pr.owner ? null : pr.owner);
          return false;
        }
      }
      if (pr.t <= 0) {
        explosion(game, pr.x, pr.z, 3, ABILITIES.bouncer.damage, pr.owner);
        return false;
      }
      return true;
    }

    if (pr.ty === 'bomblet') {
      pr.vy -= PHYS.GRAVITY * dt;
      pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.y += pr.vy * dt;
      if (pr.y <= 0 || pr.t <= 0) {
        explosion(game, pr.x, pr.z, 3, ABILITIES.cluster.damage, pr.owner);
        return false;
      }
      return true;
    }

    return pr.t > 0;
  });

  game.projectiles.push(...spawned);
}

function updateGroundItems(game, dt) {
  game.groundItems = game.groundItems.filter((g) => {
    g.t -= dt;
    if (g.t <= 0) return false;
    if (g.armT > 0) { g.armT -= dt; return true; } // arming: inert

    for (const p of game.players.values()) {
      if (p.dead || p.y > 0.8) continue;          // jump right over them!
      if (g.ty !== 'fire' && p.id === g.owner) continue; // own oil/mine safe
      const dx = p.x - g.x, dz = p.z - g.z;

      if (g.ty === 'oil') {
        if (dx * dx + dz * dz > 2.6 * 2.6) continue;
        if ((g.hitCd.get(p.id) || 0) > p.simT) continue;
        g.hitCd.set(p.id, p.simT + 2.5);
        applyStatus(game, p, 'fxSpin', 1.2, 'oilHit');
      } else if (g.ty === 'fire') {
        if (dx * dx + dz * dz > 2.2 * 2.2) continue;
        if (p.id === g.owner) continue; // your own trail never burns you
        applyDamage(game, p, ABILITIES.fire.damage * dt, g.owner, { silent: true });
      } else if (g.ty === 'mine') {
        if (dx * dx + dz * dz > 2.4 * 2.4) continue;
        applyStatus(game, p, 'fxFrozen', 1.6, 'freezeHit');
        game.pushEvent({ e: 'mineBoom', x: g.x, z: g.z });
        return false; // single-use
      }
    }
    return true;
  });
}
