/**
 * public/js/game/Effects.js
 * ------------------------------------------------------------------
 * Transient visual effects: explosions, shockwave rings, railgun
 * beams, chain-lightning arcs. Each effect is a short-lived mesh with
 * its own update rule; the manager owns their whole lifecycle so the
 * renderer just calls spawn functions and update(dt).
 */

import * as THREE from 'three';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    /** @type {Array<{mesh:THREE.Object3D,t:number,dur:number,kind:string,r?:number}>} */
    this.items = [];
    this.shake = 0; // camera shake amount, consumed by the renderer
  }

  add(mesh, dur, kind, extra = {}) {
    this.scene.add(mesh);
    this.items.push({ mesh, t: 0, dur, kind, ...extra });
  }

  /* --------------------------- spawners --------------------------- */

  explosion(x, z, r = 4.5, big = false) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 10),
      new THREE.MeshBasicMaterial({
        color: big ? 0xffa030 : 0xffc86b, transparent: true, opacity: 0.95,
      }),
    );
    mesh.position.set(x, 1.2, z);
    this.add(mesh, big ? 0.8 : 0.5, 'grow', { r: big ? r * 1.6 : r });
    this.shake = Math.max(this.shake, big ? 0.9 : 0.4);
  }

  /** Expanding flat ring — shockwave (pink) and EMP (blue). */
  ring(x, z, r, color = 0xff4d88) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.3, z);
    this.add(mesh, 0.5, 'grow', { r });
  }

  /**
   * Straight beam: railgun slug (defaults) or minigun tracer (thin,
   * yellow, very brief).
   */
  beam(x1, z1, x2, z2, color = 0x7bff8e, dur = 0.18, thick = 0.3) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(thick, thick, len),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }),
    );
    mesh.position.set((x1 + x2) / 2, 1.1, (z1 + z2) / 2);
    mesh.rotation.y = Math.atan2(dx, dz);
    this.add(mesh, dur, 'fade');
  }

  /** Chain lightning: jagged polyline through the hit positions. */
  lightning(pts) {
    const verts = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const SEGS = 6;
      for (let s = 0; s < SEGS; s++) {
        const t0 = s / SEGS, t1 = (s + 1) / SEGS;
        const jag = () => (Math.random() - 0.5) * 1.6;
        verts.push(
          ax + (bx - ax) * t0 + (s ? jag() : 0), 1.4 + Math.random(), az + (bz - az) * t0 + (s ? jag() : 0),
          ax + (bx - ax) * t1 + (s < SEGS - 1 ? jag() : 0), 1.4 + Math.random(), az + (bz - az) * t1 + (s < SEGS - 1 ? jag() : 0),
        );
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mesh = new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color: 0xaad4ff, transparent: true, opacity: 1 }));
    this.add(mesh, 0.22, 'fade');
  }

  /* ---------------------------- update ----------------------------- */

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) {
        this.scene.remove(it.mesh);
        it.mesh.geometry?.dispose();
        it.mesh.material?.dispose();
        this.items.splice(i, 1);
        continue;
      }
      if (it.kind === 'grow') {
        const s = 1 + k * (it.r ?? 4);
        it.mesh.scale.set(s, s, s);
        it.mesh.material.opacity = 0.95 * (1 - k);
      } else if (it.kind === 'fade') {
        it.mesh.material.opacity = 1 - k;
      }
    }
  }

  /** Remove every live effect (scene teardown). */
  dispose() {
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      it.mesh.geometry?.dispose();
      it.mesh.material?.dispose();
    }
    this.items.length = 0;
  }
}
