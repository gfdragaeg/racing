/**
 * public/js/game/GameClient.js
 * ------------------------------------------------------------------
 * Orchestrates one race on the client. Responsibilities:
 *
 *  PREDICTION   — our own car runs the shared physics locally every
 *                 frame, so driving feels zero-latency.
 *  RECONCILE    — every snapshot, we reset to the server's state for
 *                 our car and replay the inputs it hasn't processed
 *                 yet (input sequence numbers are acked per player).
 *  INTERPOLATE  — remote cars render ~120 ms in the past, smoothly
 *                 blended between the two snapshots around that time.
 *  PRESENT      — hands a plain "world view" to the Renderer, updates
 *                 the HUD and fires audio/VFX from server events.
 *
 * The server remains fully authoritative: nothing simulated here can
 * change the real race state.
 */

import { buildTrack, collideWithTrack, terrainModsAt } from '/shared/tracks.js';
import { stepVehicle, copyVehicleState } from '/shared/physics.js';
import {
  PHYS, JAM_SPEED_MUL, SLIME_SLOW_SECONDS, SLIME_SPEED_MUL,
  clamp, lerp, lerpAngle,
} from '/shared/constants.js';
import { Renderer } from './Renderer.js';
import { Input } from './Input.js';
import { Hud } from '../ui/hud.js';
import { audio } from '../audio/AudioManager.js';

const INTERP_DELAY_MS = 120; // remote cars render this far in the past
const SEND_INTERVAL = 1 / 30; // input packets per second

export class GameClient {
  constructor(net) {
    this.net = net;
    this.renderer = null;
    this.input = new Input();
    this.hud = new Hud();
    this.running = false;
    this.paused = false;
  }

  /* ------------------------------------------------------------ *
   *  Race lifecycle
   * ------------------------------------------------------------ */

  /** Called on 'race:start'. Builds the world, reports ready. */
  begin(payload) {
    this.track = buildTrack(payload.track);
    this.settings = payload.settings;
    this.roster = payload.players;

    if (!this.renderer) this.renderer = new Renderer(document.getElementById('game-canvas'));
    this.renderer.build(this.track, this.roster, this.net.id);

    // --- prediction state ---
    this.predicted = null;        // authoritative-then-replayed self state
    this.visual = null;           // smoothed pose actually rendered
    this.pending = [];            // inputs not yet acked by the server
    this.seq = 0;
    this.sendAcc = 0;
    this.sendFire = false;        // edge inputs latched until actually sent
    this.sendJump = false;

    // --- snapshot buffer for interpolation ---
    this.snaps = [];
    this.latest = null;
    this.serverOffset = null;     // serverTime - clientTime estimate
    this.lastCount = null;
    this.phase = 'loading';

    this.hud.reset();
    this.hud.announce('GET READY…', 0);
    this.input.enabled = true;
    this.paused = false;

    audio.unlock();
    audio.startEngine();

    this.net.emit('race:loaded');

    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  /** Called on race end or when leaving mid-race. */
  end() {
    this.running = false;
    this.input.enabled = false;
    this.input.clearTouch(); // release any held on-screen buttons
    this.paused = false; // never carry a stale pause into the next race
    audio.stopEngine();
  }

  dispose() {
    this.end();
    this.renderer?.dispose();
    this.renderer = null;
  }

  /* ------------------------------------------------------------ *
   *  Snapshots: buffering + reconciliation
   * ------------------------------------------------------------ */

  onSnapshot(sn) {
    if (!this.running) return;

    // Track the clock offset with a slow-moving average.
    const off = sn.t - Date.now();
    this.serverOffset = this.serverOffset == null ? off : this.serverOffset * 0.9 + off * 0.1;

    this.snaps.push(sn);
    if (this.snaps.length > 40) this.snaps.shift();
    this.latest = sn;
    this.phase = sn.phase;

    for (const ev of sn.ev) this.handleEvent(ev);

    // ---- reconcile our own car ----
    const me = sn.players.find((p) => p.id === this.net.id);
    if (!me) return;
    this.me = me;

    const base = {
      x: me.x, z: me.z, y: me.y,
      vx: me.vx, vz: me.vz, vy: me.vy,
      h: me.h,
      boostMeter: me.bm, boostTime: me.bt,
      fxSpin: me.sp, fxFrozen: me.fr, fxEmp: me.em, fxJam: me.jm ?? 0,
      fxSlime: me.sl ?? 0,
      trackIdx: this.predicted?.trackIdx ?? null,
      wallHit: false,
    };

    if (sn.phase !== 'racing' || me.dead || me.fin) {
      // Nothing to predict: mirror the server exactly.
      this.predicted = base;
      this.pending.length = 0;
      if (!this.visual || me.dead) this.visual = { ...base };
      return;
    }

    // Drop inputs the server has already applied, replay the rest on
    // top of its authoritative state.
    this.pending = this.pending.filter((c) => c.seq > me.ack);
    for (const cmd of this.pending) {
      stepVehicle(base, cmd.input, cmd.dt, this.localMods(base));
      collideWithTrack(this.track, base, cmd.dt);
    }
    this.predicted = base;
    if (!this.visual) this.visual = { ...base };
  }

  /** Same situational modifiers the server computes for our car. */
  localMods(st) {
    const m = terrainModsAt(this.track, st);
    if (st.fxJam > 0) m.maxMul *= JAM_SPEED_MUL;
    if (st.fxSlime > 0 && st.fxSlime <= SLIME_SLOW_SECONDS) m.maxMul *= SLIME_SPEED_MUL;
    return m;
  }

  /* ------------------------------------------------------------ *
   *  Main loop
   * ------------------------------------------------------------ */

  loop(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this.loop(t));

    const dt = clamp((now - this.lastFrame) / 1000, 0.001, 0.05);
    this.lastFrame = now;
    if (!this.latest) return; // no world yet

    this.driveLocal(dt, now);
    this.present(dt);
  }

  /** Sample input, advance the local prediction, ship inputs upstream. */
  driveLocal(dt, _now) {
    const canDrive = this.phase === 'racing' && this.predicted &&
      this.me && !this.me.dead && !this.me.fin && !this.paused;

    if (canDrive) {
      const input = this.paused ? Input.idle() : this.input.sample();
      this.seq++;
      this.pending.push({ seq: this.seq, input, dt });
      if (this.pending.length > 120) this.pending.shift(); // runaway guard

      stepVehicle(this.predicted, input, dt, this.localMods(this.predicted));
      collideWithTrack(this.track, this.predicted, dt);

      // Edge inputs (fire/jump) are latched here so they survive until
      // the next network send. sample() runs every render frame but we
      // only emit at 30 Hz, so without this a tap that lands between
      // sends would be consumed and NEVER reach the server (fast phones
      // dropped ~half of all fire taps -> "it takes a while to fire").
      if (input.jump) this.sendJump = true;
      if (input.fire) this.sendFire = true;

      // Continuous input goes out at a fixed 30 Hz, but a pending edge
      // flushes IMMEDIATELY so abilities/hops fire on command.
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_INTERVAL || this.sendFire || this.sendJump) {
        this.sendAcc = 0;
        this.net.emit('race:input', {
          seq: this.seq,
          th: input.th, st: input.st, drift: input.drift, boost: input.boost,
          jump: this.sendJump, fire: this.sendFire,
        });
        this.sendFire = false;
        this.sendJump = false;
      }
    }

    // Smooth the rendered pose toward the predicted pose — this hides
    // small reconciliation corrections without adding control latency.
    if (this.predicted) {
      if (!this.visual) this.visual = { ...this.predicted };
      const k = 1 - Math.exp(-18 * dt);
      this.visual.x = lerp(this.visual.x, this.predicted.x, k);
      this.visual.z = lerp(this.visual.z, this.predicted.z, k);
      this.visual.y = lerp(this.visual.y, this.predicted.y, k);
      this.visual.h = lerpAngle(this.visual.h, this.predicted.h, k);
    }
  }

  /** Interpolate remotes, assemble the world view, render + HUD + audio. */
  present(dt) {
    const sn = this.latest;
    const renderT = Date.now() + (this.serverOffset ?? 0) - INTERP_DELAY_MS;

    // Find the pair of snapshots straddling renderT.
    let a = null, b = null;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].t <= renderT) {
        a = this.snaps[i];
        b = this.snaps[i + 1] || null;
        break;
      }
    }
    if (!a) a = this.snaps[0];
    const alpha = b ? clamp((renderT - a.t) / (b.t - a.t || 1), 0, 1) : 0;

    const players = [];
    for (const pa of a.players) {
      const isMe = pa.id === this.net.id;
      const pb = b?.players.find((q) => q.id === pa.id);
      const cur = sn.players.find((q) => q.id === pa.id) || pa;

      let x, z, y, h;
      if (isMe && this.visual && !cur.dead) {
        // Our car renders at the predicted (smoothed) pose.
        ({ x, z, y, h } = this.visual);
      } else if (pb) {
        x = lerp(pa.x, pb.x, alpha);
        z = lerp(pa.z, pb.z, alpha);
        y = lerp(pa.y, pb.y, alpha);
        h = lerpAngle(pa.h, pb.h, alpha);
      } else {
        ({ x, z, y, h } = pa);
      }

      players.push({
        id: pa.id, x, z, y, h,
        hp: cur.hp, maxHp: this.settings.health,
        dead: !!cur.dead, fr: cur.fr, bt: isMe ? (this.predicted?.boostTime ?? cur.bt) : cur.bt,
        sh: cur.sh, inv: cur.inv,
        speed: Math.hypot(cur.vx, cur.vz),
      });
    }

    const selfPose = this.visual ?? (this.me ? { x: this.me.x, z: this.me.z, y: this.me.y, h: this.me.h } : null);
    const selfSpeed = this.predicted ? Math.hypot(this.predicted.vx, this.predicted.vz) : 0;

    this.renderer.frame({
      self: selfPose ? { ...selfPose, speed: selfSpeed } : null,
      players,
      proj: interpolateById(a.proj, b?.proj, alpha),
      grd: sn.grd,
      pk: sn.pk,
      hz: sn.hz,
      mv: interpolateById(a.mv, b?.mv, alpha, 'i'),
      lookBack: this.input.wantsLookBack(),
      dt,
    });

    this.updateHud(sn, selfSpeed);
    this.updateAudio(selfSpeed);
    this.updateCountdown(sn);
  }

  /* ------------------------------------------------------------ *
   *  HUD / audio / countdown
   * ------------------------------------------------------------ */

  updateHud(sn, selfSpeed) {
    const me = this.me;
    if (!me) return;

    let status = '';
    if (me.dead) status = 'DESTROYED — respawning…';
    else if (me.fr > 0) status = '❄ FROZEN!';
    else if (me.sp > 0) status = '🛢 SPINNING OUT!';
    else if (me.em > 0) status = '⚡ ENGINE DISABLED!';
    else if (me.jm > 0) status = '🛰️ SIGNAL JAMMED — top speed cut!';
    else if (me.sl > SLIME_SLOW_SECONDS) status = '🟢 SLIMED — wipe it off!';
    else if (me.sl > 0) status = '🟢 SLIME SLOWDOWN!';
    else if (this.predicted && this.localMods(this.predicted).accelMul < 1) {
      status = '🟤 OFF-ROAD — mud is slow!';
    }
    if (this.paused) status = 'PAUSED — race continues!';

    // Full-screen slime splatter during the COVER phase (hard to see).
    this.hud.setSlime(!me.dead && me.sl > SLIME_SLOW_SECONDS);

    const standings = [...sn.players]
      .sort((x, y2) => x.pos - y2.pos)
      .map((p) => ({
        name: this.roster.find((r) => r.id === p.id)?.name ?? '???',
        lap: p.lap, me: p.id === me.id, fin: !!p.fin,
      }));

    this.hud.update({
      pos: me.pos, count: sn.players.length,
      lap: me.lap, totalLaps: this.settings.laps,
      hp: me.hp, maxHp: this.settings.health,
      boost: me === this.me && this.predicted ? this.predicted.boostMeter : me.bm,
      ability: me.ab,
      speed: selfSpeed,
      standings, status,
    });
  }

  updateAudio(selfSpeed) {
    const th = this.me && !this.me.dead ? Math.abs(this.input.keys.has('KeyW') || this.input.keys.has('ArrowUp') ? 1 : 0) : 0;
    audio.updateEngine(clamp(selfSpeed / PHYS.MAX_SPEED, 0, 1.3), th, (this.predicted?.boostTime ?? 0) > 0);
  }

  updateCountdown(sn) {
    if (sn.phase === 'countdown') {
      const remain = Math.max(0, sn.phaseEnd - (Date.now() + (this.serverOffset ?? 0)));
      const count = Math.ceil(remain / 1000);
      if (count !== this.lastCount) {
        this.lastCount = count;
        this.hud.announce(String(count), 0);
        audio.play('count');
      }
    } else if (this.lastCount != null && sn.phase === 'racing') {
      this.lastCount = null;
      this.hud.announce('GO!', 900);
      audio.play('go');
      audio.play('crowd');
    }
  }

  /* ------------------------------------------------------------ *
   *  Server events -> VFX + SFX + announcements
   * ------------------------------------------------------------ */

  /** Distance from our car to an event, for audio attenuation. */
  distTo(x, z) {
    if (!this.visual || x == null) return 0;
    return Math.hypot(this.visual.x - x, this.visual.z - z);
  }

  handleEvent(ev) {
    const fx = this.renderer?.effects;
    const meId = this.net.id;
    switch (ev.e) {
      case 'boom':
        fx?.explosion(ev.x, ev.z, ev.r ?? 4.5, !!ev.big);
        audio.play(ev.big ? 'boomBig' : 'boom', this.distTo(ev.x, ev.z));
        if (ev.id === meId && ev.big) this.hud.announce('💥 DESTROYED!', 1500);
        break;
      case 'rail':
        fx?.beam(ev.x1, ev.z1, ev.x2, ev.z2);
        audio.play('rail', this.distTo(ev.x1, ev.z1));
        break;
      case 'tracer':
        fx?.tracer(ev.x1, ev.z1, ev.x2, ev.z2);
        audio.play('gun', this.distTo(ev.x1, ev.z1));
        break;
      case 'chain':
        fx?.lightning(ev.pts);
        audio.play('chain', this.distTo(ev.pts[0][0], ev.pts[0][1]));
        break;
      case 'empBlast':
        fx?.emp(ev.x, ev.z, ev.r);
        audio.play('emp', this.distTo(ev.x, ev.z));
        break;
      case 'shockwave':
        fx?.shock(ev.x, ev.z, ev.r);
        audio.play('shock', this.distTo(ev.x, ev.z));
        break;
      case 'mineBoom':
        fx?.ring(ev.x, ev.z, 3, 0x9adfff);
        fx?.burst(ev.x, 0.8, ev.z, { count: 12, color: 0x9adfff, speed: 9, size: 0.5, dur: 0.4 });
        audio.play('freeze', this.distTo(ev.x, ev.z));
        break;
      case 'pickup':
        if (ev.id === meId) audio.play('pickup');
        break;
      case 'use':
        if (ev.id === meId) audio.play('use');
        break;
      case 'hit':
        if (ev.id === meId) audio.play('hit');
        break;
      case 'oilHit':
        if (ev.id === meId) audio.play('oil');
        break;
      case 'freezeHit':
        if (ev.id === meId) audio.play('freeze');
        break;
      case 'shieldPop':
        audio.play('shieldPop');
        break;
      case 'pad':
        if (ev.id === meId) audio.play('pad');
        break;
      case 'wall':
        if (ev.id === meId) audio.play('wall');
        break;
      case 'bump':
        audio.play('hit', this.distTo(ev.x, ev.z));
        break;
      case 'lap':
        if (ev.id === meId) {
          audio.play('lap');
          if (ev.lap === this.settings.laps - 1) this.hud.announce('FINAL LAP!');
          else if (ev.lap < this.settings.laps) this.hud.announce(`LAP ${ev.lap + 1}/${this.settings.laps}`);
        }
        break;
      case 'finish':
        if (ev.id === meId) {
          audio.play('finish');
          this.hud.announce('🏁 FINISHED!', 4000);
        }
        break;
      case 'respawn':
        if (ev.id === meId) this.visual = null; // snap camera to spawn
        break;
      case 'jam':
        // The 1st-place victim's screen glitches; the caster hears a hit.
        if (ev.id === meId) {
          this.hud.glitch('SIGNAL JAMMED');
          audio.play('jam');
        } else if (ev.by === meId) {
          this.hud.announce('🛰️ LEADER JAMMED!', 1600);
          audio.play('use');
        }
        break;
      case 'jamFizzle':
        if (ev.id === meId) this.hud.announce("You're already in 1st! 🛰️", 1600);
        break;
      case 'slime':
        if (ev.id === meId) {
          audio.play('slime');
          this.hud.announce('🟢 SLIMED!', 1400);
        } else if (ev.by === meId) {
          audio.play('use');
          this.hud.announce('🟢 SLIME HIT!', 1400);
        }
        break;
      case 'slimeSplat':
        fx?.slimeSplat(ev.x, ev.z);
        audio.play('slime', this.distTo(ev.x, ev.z));
        break;
      case 'fell':
        if (ev.id === meId) {
          this.visual = null; // snap camera to the lap-start respawn
          audio.play('fell');
          this.hud.announce('🕳️ FELL IN! Restarting lap…', 1800);
        }
        break;
    }
  }
}

/** Interpolate two snapshot object lists matched by id/key. */
function interpolateById(listA, listB, alpha, key = 'id') {
  if (!listB || alpha <= 0) return listA;
  return listA.map((a) => {
    const b = listB.find((q) => q[key] === a[key]);
    if (!b) return a;
    return {
      ...a,
      x: lerp(a.x, b.x, alpha),
      z: lerp(a.z, b.z, alpha),
      y: a.y != null ? lerp(a.y, b.y, alpha) : undefined,
      h: a.h != null ? lerpAngle(a.h, b.h, alpha) : undefined,
    };
  });
}
