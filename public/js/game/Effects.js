/**
 * public/js/game/Effects.js
 * ------------------------------------------------------------------
 * Transient combat VFX: explosions, shockwave/EMP rings, railgun and
 * minigun beams, chain-lightning arcs, slime splats and projectile
 * trails. Everything is built from primitives + a lightweight GPU
 * particle system (THREE.Points), so there are still zero art assets.
 *
 * The manager owns each effect's whole lifecycle: spawn functions push
 * short-lived meshes with an update rule ("kind"), and update(dt)
 * advances and disposes them. The renderer just calls the spawners.
 */

import * as THREE from 'three';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.shake = 0; // camera shake amount, consumed by the renderer
  }

  add(mesh, dur, kind, extra = {}) {
    this.scene.add(mesh);
    this.items.push({ mesh, t: 0, dur, kind, ...extra });
    return mesh;
  }

  /* ======================= building blocks ======================== */

  /**
   * A burst of point-sprite particles (sparks, debris, smoke motes)
   * flying out from (x,y,z) with gravity and fade.
   */
  burst(x, y, z, opts = {}) {
    const {
      count = 16, color = 0xffd070, speed = 12, spread = 1.2,
      size = 0.5, gravity = 20, dur = 0.6, upward = 0.55, opacity = 1,
    } = opts;
    const positions = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * spread);
      vels[i * 3] = Math.cos(a) * sp;
      vels[i * 3 + 1] = (upward + Math.random() * 0.7) * sp;
      vels[i * 3 + 2] = Math.sin(a) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mesh = new THREE.Points(geo, new THREE.PointsMaterial({
      color, size, transparent: true, opacity, depthWrite: false,
    }));
    this.add(mesh, dur, 'particles', { vels, gravity });
  }

  /** Expanding flat ring on the ground. */
  ring(x, z, r, color = 0xff4d88, dur = 0.5, y = 0.3, opacity = 0.9) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1, 40),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    this.add(mesh, dur, 'grow', { r });
  }

  /** Small soft puff (used for projectile trails). */
  trailPuff(x, y, z, color = 0xffa030, size = 0.9, dur = 0.4) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 6, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    mesh.position.set(x, y, z);
    this.add(mesh, dur, 'grow', { r: 0.8 });
  }

  /* =========================== weapons ============================ */

  /** Rocket / cluster / bomblet blast: flash + fireball + shock + smoke + sparks. */
  explosion(x, z, r = 4.5, big = false) {
    // White-hot core flash.
    this.add(sphere(x, 1.2, z, 0xffffff, 1), big ? 0.18 : 0.13, 'grow', { r: big ? r * 0.8 : r * 0.5 });
    // Fireball.
    this.add(sphere(x, 1.2, z, big ? 0xff7a20 : 0xffa845, 0.95), big ? 0.6 : 0.42, 'grow', { r: big ? r * 1.4 : r });
    // Ground shock ring.
    this.ring(x, z, big ? r * 2.3 : r * 1.5, 0xffc070, big ? 0.5 : 0.38, 0.25, 0.85);
    // Rising smoke ball.
    this.add(sphere(x, 1.5, z, 0x201c16, 0.5), big ? 1.3 : 0.9, 'smoke', { r: big ? r * 1.2 : r * 0.8, base: 0.5 });
    // Spark + debris burst.
    this.burst(x, 1, z, {
      count: big ? 30 : 18, color: 0xffd070,
      speed: big ? 20 : 13, size: 0.55, dur: big ? 0.8 : 0.55,
    });
    this.shake = Math.max(this.shake, big ? 1.0 : 0.45);
  }

  /** Railgun slug: white core + coloured glow sheath + muzzle & impact sparks. */
  beam(x1, z1, x2, z2, color = 0x7bff8e) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    // Outer glow.
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, len),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false }));
    glow.position.set(cx, 1.1, cz); glow.rotation.y = yaw;
    this.add(glow, 0.28, 'fade');
    // Bright core.
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28, len),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false }));
    core.position.set(cx, 1.1, cz); core.rotation.y = yaw;
    this.add(core, 0.2, 'fade');
    this.burst(x1, 1.1, z1, { count: 8, color, speed: 7, size: 0.5, dur: 0.25, upward: 0.3 });
    this.burst(x2, 1.1, z2, { count: 12, color, speed: 11, size: 0.55, dur: 0.4 });
    this.shake = Math.max(this.shake, 0.25);
  }

  /** Minigun tracer: cheap thin streak + tiny impact spark (fires rapidly). */
  tracer(x1, z1, x2, z2) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const streak = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, len),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 1, depthWrite: false }));
    streak.position.set((x1 + x2) / 2, 1.1, (z1 + z2) / 2);
    streak.rotation.y = Math.atan2(dx, dz);
    this.add(streak, 0.09, 'fade');
    this.burst(x2, 1.1, z2, { count: 4, color: 0xffe08a, speed: 6, size: 0.4, dur: 0.22 });
  }

  /** Shockwave: double expanding ring + a low dome + a spark ring. */
  shock(x, z, r, color = 0xff4d88) {
    this.ring(x, z, r, color, 0.5, 0.3, 0.95);
    this.ring(x, z, r * 0.7, 0xffffff, 0.35, 0.32, 0.7); // inner flash ring
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    dome.position.set(x, 0.1, z);
    this.add(dome, 0.45, 'grow', { r: r * 0.9 });
    this.burst(x, 0.6, z, { count: 16, color, speed: 14, size: 0.5, dur: 0.5, upward: 0.25 });
    this.shake = Math.max(this.shake, 0.4);
  }

  /** EMP: electric-blue ring + crackling arcs radiating outward. */
  emp(x, z, r, color = 0x38e0ff) {
    this.ring(x, z, r, color, 0.5, 0.3, 0.9);
    this.ring(x, z, r * 0.6, 0xffffff, 0.3, 0.32, 0.6);
    // A few short lightning arcs shooting out to the ring edge.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
      this.lightning([[x, z], [x + Math.sin(a) * r, z + Math.cos(a) * r]], color, 0.25);
    }
    this.burst(x, 0.8, z, { count: 14, color, speed: 10, size: 0.45, dur: 0.4 });
  }

  /** Green slime splat: goopy ring + blob burst. */
  slimeSplat(x, z) {
    this.ring(x, z, 3, 0x8dff2a, 0.5, 0.15, 0.9);
    this.add(sphere(x, 0.6, z, 0x8dff2a, 0.85), 0.5, 'grow', { r: 2 });
    this.burst(x, 0.7, z, { count: 16, color: 0x9dff45, speed: 8, size: 0.7, dur: 0.6, gravity: 26 });
  }

  /**
   * Chain lightning / EMP arc: a jagged, glowing polyline through the
   * given [x,z] points, with bright nodes and a spark at each end.
   */
  lightning(pts, color = 0xaad4ff, dur = 0.24) {
    const verts = [];
    const jag = () => (Math.random() - 0.5) * 1.7;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const SEGS = 7;
      for (let s = 0; s < SEGS; s++) {
        const t0 = s / SEGS, t1 = (s + 1) / SEGS;
        verts.push(
          ax + (bx - ax) * t0 + (s ? jag() : 0), 1.4 + Math.random(), az + (bz - az) * t0 + (s ? jag() : 0),
          ax + (bx - ax) * t1 + (s < SEGS - 1 ? jag() : 0), 1.4 + Math.random(), az + (bz - az) * t1 + (s < SEGS - 1 ? jag() : 0),
        );
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.add(new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false })),
      dur, 'fade');
    // Glowing nodes at each hit point.
    for (const [px, pz] of pts) {
      this.add(sphere(px, 1.4, pz, 0xffffff, 0.95), dur, 'grow', { r: 1.4 });
    }
  }

  /* ============================ update ============================ */

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { this.remove(i); continue; }

      if (it.kind === 'grow') {
        const s = 1 + k * (it.r ?? 4);
        it.mesh.scale.set(s, s, s);
        it.mesh.material.opacity = 0.95 * (1 - k);
      } else if (it.kind === 'fade') {
        it.mesh.material.opacity = 1 - k;
      } else if (it.kind === 'smoke') {
        const s = 1 + k * (it.r ?? 4);
        it.mesh.scale.set(s, s, s);
        it.mesh.position.y += dt * 1.6;
        it.mesh.material.opacity = (it.base ?? 0.5) * (1 - k);
      } else if (it.kind === 'particles') {
        const pos = it.mesh.geometry.attributes.position;
        const v = it.vels;
        for (let p = 0; p < pos.count; p++) {
          v[p * 3 + 1] -= it.gravity * dt;
          pos.setXYZ(
            p,
            pos.getX(p) + v[p * 3] * dt,
            Math.max(0.05, pos.getY(p) + v[p * 3 + 1] * dt),
            pos.getZ(p) + v[p * 3 + 2] * dt,
          );
        }
        pos.needsUpdate = true;
        it.mesh.material.opacity = 1 - k;
      }
    }
  }

  remove(i) {
    const it = this.items[i];
    this.scene.remove(it.mesh);
    it.mesh.geometry?.dispose();
    it.mesh.material?.dispose();
    this.items.splice(i, 1);
  }

  dispose() {
    for (let i = this.items.length - 1; i >= 0; i--) this.remove(i);
    this.items.length = 0;
  }
}

/** Small helper: an unlit sphere mesh at a position. */
function sphere(x, y, z, color, opacity) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  m.position.set(x, y, z);
  return m;
}
