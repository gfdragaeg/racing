/**
 * server/game/Game.js
 * ------------------------------------------------------------------
 * One authoritative race instance per room.
 *
 * The server is the single source of truth for positions, collisions,
 * lap counting, abilities, pickups, health and results. Clients only
 * ever send inputs; everything they see comes from the snapshots
 * broadcast here at SNAP_RATE Hz.
 *
 * Race phases:
 *   loading   -> waiting for every human client to build its scene
 *   countdown -> 3-2-1 (cars locked in place)
 *   racing    -> the actual race
 *   ended     -> results have been emitted; simulation stops
 */

import {
  TICK_RATE, SNAP_RATE, COUNTDOWN_MS, RESPAWN_SECONDS, INVULN_SECONDS,
  FINISH_GRACE_SECONDS, PHYS, PICKUP_RATES, BOT_NAMES, PLAYER_COLORS,
  MAX_PLAYERS, JAM_SPEED_MUL, clamp, wrapAngle,
} from '../../shared/constants.js';
import { buildTrack, collideWithTrack, terrainModsAt, crossedForward } from '../../shared/tracks.js';
import { stepVehicle } from '../../shared/physics.js';
import { useAbility, updateWorldObjects, applyDamage, grantRandomAbility, fireMinigunShot } from './Abilities.js';
import { computeBotInput } from './Bots.js';

const DT = 1 / TICK_RATE;
const SNAP_EVERY = Math.round(TICK_RATE / SNAP_RATE);

export class Game {
  /**
   * @param {import('socket.io').Server} io
   * @param {object} room     the lobby room (players/settings/code)
   * @param {Function} onEnd  callback fired once when the race ends
   */
  constructor(io, room, onEnd) {
    this.io = io;
    this.room = room;
    this.code = room.code;
    this.settings = { ...room.settings };
    this.onEnd = onEnd;

    this.track = buildTrack(this.settings.map);
    this.phase = 'loading';
    this.phaseEnd = Date.now() + 10000; // loading timeout safety net
    this.raceStartAt = 0;
    this.firstFinishAt = 0;

    this.players = new Map();  // id -> racer (humans and bots alike)
    this.projectiles = [];     // rockets, cluster bombs, bomblets
    this.groundItems = [];     // oil slicks, fire patches, freeze mines
    this.events = [];          // one-shot events flushed with each snapshot
    this.nextObjectId = 1;
    this.tickCount = 0;

    this.buildRacers();
    this.initPickups();
  }

  /* ------------------------------------------------------------ *
   *  Setup
   * ------------------------------------------------------------ */

  buildRacers() {
    // Humans from the lobby, in slot order for a fair grid.
    const humans = [...this.room.players.values()].sort((a, b) => a.slot - b.slot);
    let grid = 0;
    for (const lp of humans) {
      this.players.set(lp.id, this.makeRacer(lp.id, lp.name, lp.color, grid++, false));
    }
    // Fill with bots up to the host's setting (never past MAX_PLAYERS).
    const botCount = Math.min(this.settings.bots, MAX_PLAYERS - humans.length);
    for (let b = 0; b < botCount; b++) {
      const id = `bot-${b}`;
      const color = PLAYER_COLORS[grid % PLAYER_COLORS.length];
      const racer = this.makeRacer(id, BOT_NAMES[b % BOT_NAMES.length], color, grid++, true);
      racer.botSkill = 0.9 + Math.random() * 0.1; // varied but competitive
      this.players.set(id, racer);
    }
  }

  makeRacer(id, name, color, gridSlot, isBot) {
    const spawn = this.track.spawns[gridSlot % this.track.spawns.length];
    return {
      id, name, color, isBot, gridSlot,
      // --- physics state (fields consumed by shared/physics.js) ---
      x: spawn.x, z: spawn.z, y: 0,
      vx: 0, vz: 0, vy: 0,
      h: spawn.h,
      boostMeter: 0, boostTime: 0,
      fxSpin: 0, fxFrozen: 0, fxEmp: 0, fxJam: 0,
      trackIdx: null, wallHit: false,
      // --- race progress ---
      s: spawn.s,        // lap fraction at last tick
      nextCp: 1,         // grid sits just past the line, so chase cp 1
      lapsDone: 0,
      score: 0,          // continuous progress metric for positions
      position: gridSlot + 1,
      lapStartT: 0, bestLap: 0,
      finished: false, finishTime: 0,
      // --- combat ---
      hp: this.settings.health, maxHp: this.settings.health,
      dead: false, deadT: 0, invulnT: 0,
      ability: null, shieldT: 0, fireTrailT: 0, fireDropT: 0,
      gunT: 0, gunCd: 0,
      // --- input ---
      input: { th: 0, st: 0, drift: false, boost: false },
      pendingJump: false, pendingFire: false, lastSeq: 0,
      loaded: isBot, // bots never "load"
      // --- bookkeeping ---
      padCooldown: new Map(),     // boost pad index -> expires (s)
      hazardCooldown: new Map(),  // hazard index -> expires (s)
      stats: { dealt: 0, taken: 0, used: 0 },
      stuckT: 0, botFireT: 0, disconnected: false,
      simT: 0, // per-race simulation clock, seconds
    };
  }

  initPickups() {
    // In classic mode there are no ability crates at all.
    const enabled = this.settings.mode !== 'classic';
    this.pickups = this.track.pickups.map((p) => ({
      i: p.i, x: p.x, z: p.z,
      active: enabled, respawnAt: 0, enabled,
    }));
    this.pickupRespawn = PICKUP_RATES[this.settings.rate] ?? 10;
  }

  /* ------------------------------------------------------------ *
   *  Lifecycle
   * ------------------------------------------------------------ */

  start() {
    // Tell everyone to load the track; humans reply with race:loaded.
    this.io.to(this.code).emit('race:start', {
      track: this.settings.map,
      settings: this.settings,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot, slot: p.gridSlot,
      })),
    });
    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  destroy() {
    clearInterval(this.interval);
    this.interval = null;
  }

  markLoaded(id) {
    const p = this.players.get(id);
    if (p) p.loaded = true;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.disconnected = true;
    this.players.delete(id);
    this.pushEvent({ e: 'leave', id });
  }

  setInput(id, data) {
    const p = this.players.get(id);
    if (!p || p.isBot || typeof data !== 'object') return;
    p.input.th = clamp(Number(data.th) || 0, -1, 1);
    p.input.st = clamp(Number(data.st) || 0, -1, 1);
    p.input.drift = !!data.drift;
    p.input.boost = !!data.boost;
    if (data.jump) p.pendingJump = true;  // edges are latched until the
    if (data.fire) p.pendingFire = true;  // next tick consumes them
    p.lastSeq = Number(data.seq) || p.lastSeq;
  }

  pushEvent(ev) { this.events.push(ev); }

  now() { return Date.now(); }

  /* ------------------------------------------------------------ *
   *  Main tick
   * ------------------------------------------------------------ */

  tick() {
    this.tickCount++;
    this.updatePhase();

    if (this.phase === 'racing') {
      for (const p of this.players.values()) this.tickRacer(p);
      this.resolveCarCollisions();
      updateWorldObjects(this, DT);
      this.updateHazards();
      this.updatePickups();
      this.updatePositions();
      this.checkRaceEnd();
    }

    if (this.tickCount % SNAP_EVERY === 0) this.broadcastSnapshot();
  }

  updatePhase() {
    const now = this.now();
    if (this.phase === 'loading') {
      const humans = [...this.players.values()].filter((p) => !p.isBot);
      const allLoaded = humans.every((p) => p.loaded);
      if (allLoaded || now > this.phaseEnd) {
        this.phase = 'countdown';
        this.phaseEnd = now + COUNTDOWN_MS;
        this.pushEvent({ e: 'countdown' });
      }
    } else if (this.phase === 'countdown' && now >= this.phaseEnd) {
      this.phase = 'racing';
      this.raceStartAt = now;
      for (const p of this.players.values()) p.lapStartT = now;
      this.pushEvent({ e: 'go' });
    }
  }

  /* ------------------------------------------------------------ *
   *  Per-racer simulation
   * ------------------------------------------------------------ */

  tickRacer(p) {
    p.simT += DT;
    p.invulnT = Math.max(0, p.invulnT - DT);
    p.shieldT = Math.max(0, p.shieldT - DT);

    // Dead cars just count down to respawn.
    if (p.dead) {
      p.deadT -= DT;
      if (p.deadT <= 0) this.respawn(p);
      return;
    }

    // Pick the input source: bot brain for bots AND for finished
    // humans (their car cruises on autopilot so it doesn't block the
    // track while they watch the end screen).
    let input;
    if (p.isBot || p.finished) {
      input = computeBotInput(this, p);
    } else {
      input = { ...p.input, jump: p.pendingJump };
      p.pendingJump = false;
    }

    // Ability activation (edge-triggered).
    if (p.pendingFire) {
      p.pendingFire = false;
      if (p.ability && !p.finished) useAbility(this, p);
    }
    if (p.isBot && input.fire && p.ability) useAbility(this, p);

    // Situational modifiers: base grip, slick zones, off-road mud, and
    // the GPS-jam top-speed penalty.
    const mods = terrainModsAt(this.track, p);
    if (p.fxJam > 0) mods.maxMul *= JAM_SPEED_MUL;

    stepVehicle(p, input, DT, mods);
    const loc = collideWithTrack(this.track, p, DT);
    if (p.wallHit) this.pushEvent({ e: 'wall', id: p.id });

    this.updateProgress(p, loc);
    this.checkBoostPads(p);
    this.checkPickups(p);
    this.checkStaticHazards(p);
    this.dropFireTrail(p);
    this.updateMinigun(p);
    this.checkStuck(p, input);
  }

  /**
   * Lap fraction -> checkpoint -> lap logic. Checkpoints must be
   * crossed in order; crossing the start line (cp 0) with a full set
   * completes a lap. Shortcut corridors can sweep past more than one
   * checkpoint in a tick, hence the loop.
   */
  updateProgress(p, loc) {
    const prev = p.s;
    p.s = loc.s;

    let guard = 0;
    while (guard++ < this.track.numCps &&
           crossedForward(prev, p.s, this.track.cpS[p.nextCp])) {
      if (p.nextCp === 0) {
        // Completed a full checkpoint cycle -> lap done.
        p.lapsDone++;
        const now = this.now();
        const lapMs = now - p.lapStartT;
        p.lapStartT = now;
        if (!p.bestLap || lapMs < p.bestLap) p.bestLap = lapMs;
        this.pushEvent({ e: 'lap', id: p.id, lap: p.lapsDone });
        if (!p.finished && p.lapsDone >= this.settings.laps) this.finishRacer(p);
      }
      p.nextCp = (p.nextCp + 1) % this.track.numCps;
    }

    // Continuous ranking metric: laps + fraction of checkpoints passed
    // + fraction of the current checkpoint segment.
    const N = this.track.numCps;
    const prevCp = (p.nextCp - 1 + N) % N;
    const segStart = this.track.cpS[prevCp];
    const segLen = ((this.track.cpS[p.nextCp] - segStart + 1) % 1) || (1 / N);
    const frac = clamp((((p.s - segStart + 1) % 1)) / segLen, 0, 1);
    p.score = p.lapsDone + (prevCp + frac) / N;
  }

  finishRacer(p) {
    p.finished = true;
    p.finishTime = this.now() - this.raceStartAt;
    // The wrap-up grace timer starts when the first HUMAN finishes —
    // bots finishing must never DNF humans who are still racing.
    if (!p.isBot && !this.firstFinishAt) this.firstFinishAt = this.now();
    this.pushEvent({ e: 'finish', id: p.id });
  }

  /* ------------------------------------------------------------ *
   *  Track furniture: pads, crates, hazards
   * ------------------------------------------------------------ */

  checkBoostPads(p) {
    for (const pad of this.track.boostPads) {
      const dx = p.x - pad.x, dz = p.z - pad.z;
      if (dx * dx + dz * dz > pad.r * pad.r) continue;
      if ((p.padCooldown.get(pad.i) || 0) > p.simT) continue;
      p.padCooldown.set(pad.i, p.simT + 1.2);

      if (pad.type === 'ramp') {
        // Ramps fling the car up and forward.
        p.vy = 8.5;
        p.boostTime = Math.max(p.boostTime, 0.6);
      } else {
        p.boostTime = Math.max(p.boostTime, 1.3);
      }
      // Instant speed kick along the car's heading.
      const fx = Math.sin(p.h), fz = Math.cos(p.h);
      p.vx += fx * 10; p.vz += fz * 10;
      this.pushEvent({ e: 'pad', id: p.id, ty: pad.type });
    }
  }

  checkPickups(p) {
    if (p.ability || p.dead || p.finished) return;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      const dx = p.x - pk.x, dz = p.z - pk.z;
      if (dx * dx + dz * dz > 2.4 * 2.4) continue;
      pk.active = false;
      pk.respawnAt = this.now() + this.pickupRespawn * 1000;
      grantRandomAbility(this, p);
      break; // one crate per tick is plenty
    }
  }

  updatePickups() {
    const now = this.now();
    for (const pk of this.pickups) {
      if (pk.enabled && !pk.active && now >= pk.respawnAt) pk.active = true;
    }
  }

  /** Lava pools + timed hazards (falling rocks, collapsing bridge). */
  checkStaticHazards(p) {
    if (p.invulnT > 0) return;
    const t = this.now() / 1000;
    for (const h of this.track.hazards) {
      if (h.type === 'slick' || h.type === 'mover') continue;
      const dx = p.x - h.x, dz = p.z - h.z;
      if (dx * dx + dz * dz > h.r * h.r) continue;

      if (h.type === 'lava') {
        if (p.y < 0.5) applyDamage(this, p, h.dps * DT, null, { silent: true });
      } else {
        // rocks / collapse are only lethal during their active window
        if (this.hazardState(h, t) === 'active' && p.y < 1.5) {
          applyDamage(this, p, h.dps * DT, null, { silent: true });
        }
      }
    }
  }

  /** Where a periodic hazard is in its warn/active/idle cycle. */
  hazardState(h, tSeconds) {
    const t = (tSeconds + h.phase) % h.period;
    if (t < h.warn) return 'warn';
    if (t < h.warn + h.active) return 'active';
    return 'idle';
  }

  /** Moving glaciers: computed by time, collide-and-shove. */
  updateHazards() {
    const t = this.now() / 1000;
    for (const h of this.track.hazards) {
      if (h.type !== 'mover') continue;
      const k = (Math.sin((t / h.period) * Math.PI * 2) + 1) / 2;
      h.mx = h.x0 + (h.x1 - h.x0) * k;
      h.mz = h.z0 + (h.z1 - h.z0) * k;

      for (const p of this.players.values()) {
        if (p.dead) continue;
        const dx = p.x - h.mx, dz = p.z - h.mz;
        const rr = h.r + PHYS.CAR_RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01;
        // Push the car out of the glacier and damage on first contact.
        p.x = h.mx + (dx / d) * rr;
        p.z = h.mz + (dz / d) * rr;
        const vn = p.vx * (dx / d) + p.vz * (dz / d);
        if (vn < 0) { p.vx -= vn * (dx / d) * 1.3; p.vz -= vn * (dz / d) * 1.3; }
        if ((p.hazardCooldown.get(h.i) || 0) < p.simT) {
          p.hazardCooldown.set(h.i, p.simT + 1);
          applyDamage(this, p, h.dmg, null);
        }
      }
    }
  }

  dropFireTrail(p) {
    if (p.fireTrailT <= 0) return;
    p.fireTrailT -= DT;
    p.fireDropT -= DT;
    if (p.fireDropT <= 0) {
      p.fireDropT = 0.15;
      // Drop a burning patch just behind the rear bumper.
      const fx = Math.sin(p.h), fz = Math.cos(p.h);
      this.groundItems.push({
        id: this.nextObjectId++, ty: 'fire', owner: p.id,
        x: p.x - fx * 2.2, z: p.z - fz * 2.2, t: 4, hitCd: new Map(),
      });
    }
  }

  /** Minigun bursts: while active, fire one hitscan bullet per cooldown. */
  updateMinigun(p) {
    if (p.gunT <= 0) return;
    p.gunT -= DT;
    p.gunCd -= DT;
    if (p.gunCd > 0 || p.fxFrozen > 0 || p.fxSpin > 0) return;
    p.gunCd = 0.16;
    fireMinigunShot(this, p);
  }

  /** Bots (and finished-autopilot cars) that get pinned respawn themselves. */
  checkStuck(p, input) {
    if (!p.isBot && !p.finished) return;
    const spd = Math.hypot(p.vx, p.vz);
    if (spd < 2 && input.th > 0.3) p.stuckT += DT;
    else p.stuckT = 0;
    if (p.stuckT > 3) { p.stuckT = 0; this.respawnAtCheckpoint(p); }
  }

  /* ------------------------------------------------------------ *
   *  Car vs car collisions (simple elastic circles)
   * ------------------------------------------------------------ */

  resolveCarCollisions() {
    const list = [...this.players.values()].filter((p) => !p.dead);
    const rr = PHYS.CAR_RADIUS * 2;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (Math.abs(a.y - b.y) > 1.6) continue; // one is mid-jump
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const overlap = rr - d;
        // Separate the pair equally...
        a.x -= nx * overlap / 2; a.z -= nz * overlap / 2;
        b.x += nx * overlap / 2; b.z += nz * overlap / 2;
        // ...and exchange the closing velocity (0.5 restitution bump).
        const rvx = b.vx - a.vx, rvz = b.vz - a.vz;
        const vn = rvx * nx + rvz * nz;
        if (vn < 0) {
          const imp = -vn * 0.75;
          a.vx -= nx * imp; a.vz -= nz * imp;
          b.vx += nx * imp; b.vz += nz * imp;
          if (-vn > 8) this.pushEvent({ e: 'bump', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
        }
      }
    }
  }

  /* ------------------------------------------------------------ *
   *  Death & respawn
   * ------------------------------------------------------------ */

  explode(p, attackerId) {
    p.dead = true;
    p.deadT = RESPAWN_SECONDS;
    p.vx = p.vz = p.vy = 0;
    p.ability = null;
    p.fireTrailT = 0;
    p.gunT = 0;
    this.pushEvent({ e: 'boom', x: p.x, z: p.z, big: true, id: p.id, by: attackerId || null });
  }

  respawn(p) {
    this.respawnAtCheckpoint(p);
    p.dead = false;
    p.hp = p.maxHp;
    p.invulnT = INVULN_SECONDS;
    p.fxSpin = p.fxFrozen = p.fxEmp = p.fxJam = 0;
    p.boostTime = 0;
    this.pushEvent({ e: 'respawn', id: p.id });
  }

  /** Place a car back at the last checkpoint it passed. */
  respawnAtCheckpoint(p) {
    const N = this.track.numCps;
    const prevCp = (p.nextCp - 1 + N) % N;
    // Nudge just past the checkpoint so we don't instantly re-cross it.
    const s = this.track.cpS[prevCp] + 0.002;
    const w = this.track.worldAt(s, 0);
    p.x = w.x; p.z = w.z; p.y = 0;
    p.vx = p.vz = p.vy = 0;
    p.h = Math.atan2(w.dirX, w.dirZ);
    p.trackIdx = w.idx;
    p.s = s % 1;
  }

  /* ------------------------------------------------------------ *
   *  Rankings & race end
   * ------------------------------------------------------------ */

  updatePositions() {
    const list = [...this.players.values()];
    list.sort((a, b) => {
      // Finished racers rank by finish time, ahead of everyone else.
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.score - a.score;
    });
    list.forEach((p, i) => { p.position = i + 1; });
  }

  checkRaceEnd() {
    const humans = [...this.players.values()].filter((p) => !p.isBot);
    const allHumansDone = humans.length > 0 && humans.every((p) => p.finished);
    const graceOver = this.firstFinishAt &&
      this.now() - this.firstFinishAt > FINISH_GRACE_SECONDS * 1000;
    const nobodyLeft = humans.length === 0;
    // Hard cap so an abandoned-but-connected race can't run forever.
    const tooLong = this.raceStartAt &&
      this.now() - this.raceStartAt > 12 * 60 * 1000;

    if (allHumansDone || graceOver || nobodyLeft || tooLong) this.endRace();
  }

  endRace() {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.updatePositions();

    const results = [...this.players.values()]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot,
        position: p.position, finished: p.finished,
        timeMs: p.finished ? p.finishTime : null,
        bestLapMs: p.bestLap || null,
        damageDealt: Math.round(p.stats.dealt),
        damageTaken: Math.round(p.stats.taken),
        abilitiesUsed: p.stats.used,
        laps: p.lapsDone,
      }));

    // Fastest lap across the whole field.
    let fastest = null;
    for (const r of results) {
      if (r.bestLapMs && (!fastest || r.bestLapMs < fastest.ms)) {
        fastest = { id: r.id, name: r.name, ms: r.bestLapMs };
      }
    }

    this.io.to(this.code).emit('race:finished', { results, fastestLap: fastest });
    this.destroy();
    this.onEnd?.();
  }

  /* ------------------------------------------------------------ *
   *  Snapshots
   * ------------------------------------------------------------ */

  broadcastSnapshot() {
    const t = this.now() / 1000;
    const snapshot = {
      t: this.now(),
      phase: this.phase,
      phaseEnd: this.phaseEnd,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        x: round2(p.x), z: round2(p.z), y: round2(p.y),
        vx: round2(p.vx), vz: round2(p.vz), vy: round2(p.vy),
        h: round3(p.h),
        hp: Math.round(p.hp), bm: Math.round(p.boostMeter),
        bt: round2(p.boostTime),
        sp: round2(p.fxSpin), fr: round2(p.fxFrozen), em: round2(p.fxEmp),
        jm: round2(p.fxJam),
        sh: p.shieldT > 0 ? 1 : 0,
        ab: p.ability,
        lap: p.lapsDone, cp: p.nextCp, pos: p.position,
        dead: p.dead ? 1 : 0, fin: p.finished ? 1 : 0,
        inv: p.invulnT > 0 ? 1 : 0,
        ack: p.lastSeq,
      })),
      proj: this.projectiles.map((pr) => ({
        id: pr.id, ty: pr.ty, x: round2(pr.x), z: round2(pr.z),
        y: round2(pr.y), h: round3(pr.h ?? 0),
      })),
      grd: this.groundItems.map((g) => ({ id: g.id, ty: g.ty, x: round2(g.x), z: round2(g.z) })),
      pk: this.pickups.map((pk) => (pk.active ? 1 : 0)),
      hz: this.track.hazards
        .filter((h) => h.type === 'rocks' || h.type === 'collapse')
        .map((h) => ({ i: h.i, st: this.hazardState(h, t) })),
      mv: this.track.hazards
        .filter((h) => h.type === 'mover')
        .map((h) => ({ i: h.i, x: round2(h.mx ?? h.x0), z: round2(h.mz ?? h.z0) })),
      ev: this.events,
    };
    this.events = [];
    this.io.to(this.code).emit('race:snapshot', snapshot);
  }
}

/* Rounding helpers keep snapshot JSON compact. */
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
