/**
 * public/js/game/Renderer.js
 * ------------------------------------------------------------------
 * All Three.js concerns for the race: scene/camera/lights, car
 * meshes, projectiles, ground items, dynamic hazard visuals, weather
 * particles and the chase camera. It is a pure VIEW: every frame the
 * GameClient hands it a plain "world view" object and it makes the
 * scene match. It never talks to the network or runs game rules.
 */

import * as THREE from 'three';
import { PHYS, wrapAngle, clamp } from '/shared/constants.js';
import { buildTrackScene, THEMES } from './TrackBuilder.js';
import { Effects } from './Effects.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 900);
    this.camera.position.set(0, 6, -10);

    this.cars = new Map();        // playerId -> car rig
    this.projMeshes = new Map();  // projectile id -> mesh
    this.grdMeshes = new Map();   // ground item id -> mesh
    this.trackHandles = null;
    this.effects = new Effects(this.scene);
    this.snow = null;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();

    this._resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  /* ------------------------------------------------------------ *
   *  Scene lifecycle
   * ------------------------------------------------------------ */

  /** Build the world for a race. `players`: [{id, name, color}] */
  build(track, players, selfId) {
    this.disposeWorld();
    this.selfId = selfId;

    const theme = THEMES[track.theme];
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, 60, theme.fogFar);

    this.scene.add(new THREE.HemisphereLight(theme.ambient, 0x303038, theme.hemiInt ?? 1.1));
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunInt);
    sun.position.set(120, 180, 80);
    this.scene.add(sun);
    this.lights = [sun];

    this.trackHandles = buildTrackScene(this.scene, track);
    for (const p of players) this.addCar(p);

    if (track.theme === 'frozen') this.buildParticles('snow');
    if (track.theme === 'volcano') this.buildParticles('embers');
    this.camInit = false;
  }

  disposeWorld() {
    // Remove everything; Three GC needs explicit geometry disposal but
    // for our small scene a scene.clear + renderer keeps memory fine.
    this.effects.dispose();
    this.scene.clear();
    this.cars.clear();
    this.projMeshes.clear();
    this.grdMeshes.clear();
    this.snow = null;
    this.trackHandles = null;
  }

  dispose() {
    this.disposeWorld();
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
  }

  /* ------------------------------------------------------------ *
   *  Cars
   * ------------------------------------------------------------ */

  /**
   * Open-wheel F1-style car rig, still all primitives: narrow tub with
   * a tapered nose, front/rear wings, sidepods, exposed wheels (fronts
   * steer), a driver helmet, plus status attachments. The chassis sits
   * in its own sub-group so it can roll into corners independently of
   * the physics pose.
   */
  addCar({ id, name, color }) {
    const g = new THREE.Group();
    const chassis = new THREE.Group();
    g.add(chassis);

    const bodyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x14171f });

    // Central tub.
    const tub = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.34, 3.2), bodyMat);
    tub.position.y = 0.42;
    chassis.add(tub);

    // Tapered nose cone.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.27, 1.1, 8), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.42, 2.1);
    chassis.add(nose);

    // Sidepods.
    for (const sx of [-0.62, 0.62]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 1.5), bodyMat);
      pod.position.set(sx, 0.4, -0.35);
      chassis.add(pod);
    }

    // Cockpit opening, driver helmet, engine-cover fin.
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.28, 1.0), darkMat);
    cockpit.position.set(0, 0.62, -0.05);
    chassis.add(cockpit);
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
    helmet.position.set(0, 0.82, -0.2);
    chassis.add(helmet);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 1.0), bodyMat);
    fin.position.set(0, 0.74, -0.95);
    chassis.add(fin);

    // Front wing (low, wide) and rear wing on struts.
    const fWing = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.07, 0.5), bodyMat);
    fWing.position.set(0, 0.16, 2.35);
    chassis.add(fWing);
    const rWing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.45), bodyMat);
    rWing.position.set(0, 0.95, -1.8);
    chassis.add(rWing);
    for (const sx of [-0.5, 0.5]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.5, 0.28), darkMat);
      strut.position.set(sx, 0.66, -1.8);
      chassis.add(strut);
    }

    // Exposed wheels; the axle axis is baked along X so rotation.x
    // spins them and a pivot group's rotation.y steers the fronts.
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.4, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x141414 });
    const wheels = [];
    const frontWheels = [];
    for (const [wx, wz, front] of [[-1.0, 1.3, true], [1.0, 1.3, true], [-1.0, -1.25, false], [1.0, -1.25, false]]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheels.push(wheel);
      if (front) {
        const pivot = new THREE.Group();
        pivot.position.set(wx, 0.42, wz);
        pivot.add(wheel);
        chassis.add(pivot);
        frontWheels.push(pivot);
      } else {
        wheel.position.set(wx, 0.42, wz);
        chassis.add(wheel);
      }
    }

    // Boost flame (visible only while boosting).
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 1.6, 8),
      new THREE.MeshBasicMaterial({ color: 0x38b0ff, transparent: true, opacity: 0.9 }),
    );
    flame.rotation.x = Math.PI / 2;
    flame.position.set(0, 0.5, -2.35);
    flame.visible = false;
    chassis.add(flame);

    // Shield bubble.
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x38e0ff, transparent: true, opacity: 0.22 }),
    );
    shield.position.y = 0.8;
    shield.visible = false;
    g.add(shield);

    // Frozen ice block.
    const ice = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.2, 3.6),
      new THREE.MeshLambertMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.55 }),
    );
    ice.position.y = 1.1;
    ice.visible = false;
    g.add(ice);

    // Name tag + HP bar sprite for everyone except ourselves.
    let tag = null;
    if (id !== this.selfId) {
      tag = makeTagSprite(name, color);
      tag.position.y = 2.6;
      g.add(tag);
    }

    this.scene.add(g);
    this.cars.set(id, {
      group: g, chassis, wheels, frontWheels, flame, shield, ice, tag,
      name, color, lastHp: -1, prevH: 0,
    });
  }

  removeCar(id) {
    const car = this.cars.get(id);
    if (!car) return;
    this.scene.remove(car.group);
    this.cars.delete(id);
  }

  /* ------------------------------------------------------------ *
   *  Per-frame world sync
   * ------------------------------------------------------------ */

  /**
   * Make the scene match `view` and render one frame.
   * view = {
   *   self: {x,z,y,h,bt,speed},          // predicted local car pose
   *   players: [{id,x,z,y,h,hp,maxHp,dead,fr,bt,sh,inv,speed}],
   *   proj: [{id,ty,x,z,y,h}], grd: [{id,ty,x,z}],
   *   pk: [0|1...], hz: [{i,st}], mv: [{i,x,z}],
   *   dt: seconds
   * }
   */
  frame(view) {
    const { dt } = view;
    const seen = new Set();

    /* ---- cars ---- */
    for (const p of view.players) {
      seen.add(p.id);
      let car = this.cars.get(p.id);
      if (!car) continue; // joined mid-snapshot; cars are pre-built
      car.group.visible = !p.dead;
      car.group.position.set(p.x, p.y, p.z);
      car.group.rotation.y = p.h;
      // Spawn-protection blink.
      if (p.inv) car.group.visible = Math.floor(performance.now() / 120) % 2 === 0;

      const spd = p.speed ?? 0;
      // Wheel spin (angular velocity = v / wheel radius).
      for (const w of car.wheels) w.rotation.x += spd * dt * 2.2;
      // Front-wheel steering + body roll, both derived from the yaw
      // rate so they work for remote cars too (no input needed).
      const yawRate = dt > 0 ? wrapAngle(p.h - car.prevH) / dt : 0;
      car.prevH = p.h;
      const steer = clamp(yawRate * 0.4, -0.5, 0.5);
      const kAnim = Math.min(1, 12 * dt);
      for (const fw of car.frontWheels) fw.rotation.y += (steer - fw.rotation.y) * kAnim;
      const roll = clamp(-yawRate * spd * 0.006, -0.15, 0.15);
      car.chassis.rotation.z += (roll - car.chassis.rotation.z) * kAnim;
      car.flame.visible = !p.dead && p.bt > 0;
      car.shield.visible = !p.dead && !!p.sh;
      car.ice.visible = !p.dead && p.fr > 0;

      // Update the floating HP bar only when HP actually changes.
      if (car.tag && p.hp !== car.lastHp) {
        car.lastHp = p.hp;
        updateTagSprite(car.tag, car.name, car.color, p.hp / (p.maxHp || 100));
      }
    }
    for (const id of this.cars.keys()) {
      if (!seen.has(id)) this.removeCar(id); // disconnected mid-race
    }

    /* ---- projectiles ---- */
    this.syncPool(this.projMeshes, view.proj, (pr) => makeProjectileMesh(pr.ty),
      (mesh, pr) => {
        mesh.position.set(pr.x, Math.max(pr.y, 0.4), pr.z);
        mesh.rotation.y = pr.h;
      });

    /* ---- ground items (oil, fire, mines) ---- */
    this.syncPool(this.grdMeshes, view.grd, (g) => makeGroundMesh(g.ty),
      (mesh, g) => {
        mesh.position.set(g.x, mesh.userData.y, g.z);
        if (g.ty === 'fire') {
          // flicker
          mesh.material.opacity = 0.65 + Math.sin(performance.now() / 60 + g.id) * 0.25;
        }
      });

    /* ---- pickups: float, spin, hide when collected ---- */
    if (this.trackHandles) {
      const t = performance.now() / 1000;
      this.trackHandles.pickupMeshes.forEach((m, i) => {
        m.visible = !!view.pk[i];
        m.rotation.y = t * 1.5;
        m.position.y = 1.3 + Math.sin(t * 2 + i) * 0.25;
      });

      /* ---- timed hazards (rocks / collapse) ---- */
      for (const h of view.hz) {
        const vis = this.trackHandles.hazardVisuals[h.i];
        if (!vis || !vis.ring) continue;
        vis.ring.visible = h.st === 'warn';
        vis.danger.visible = h.st === 'active';
        if (vis.type === 'rocks' && h.st === 'active') {
          // rock slams down over the active window
          vis.danger.position.y = Math.max(1.2, vis.danger.position.y - dt * 26);
        } else if (vis.type === 'rocks') {
          vis.danger.position.y = 14;
        }
      }

      /* ---- moving glaciers ---- */
      for (const m of view.mv) {
        const mesh = this.trackHandles.moverMeshes[m.i];
        if (mesh) mesh.position.set(m.x, 1.7, m.z);
      }
    }

    /* ---- weather ---- */
    if (this.snow) this.updateParticles(dt);

    /* ---- effects & camera ---- */
    this.effects.update(dt);
    this.updateCamera(view.self, dt, view.lookBack);
    this.renderer.render(this.scene, this.camera);
  }

  /** Generic id-keyed mesh pool sync: create, update, remove. */
  syncPool(pool, list, create, update) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let mesh = pool.get(item.id);
      if (!mesh) {
        mesh = create(item);
        this.scene.add(mesh);
        pool.set(item.id, mesh);
      }
      update(mesh, item);
    }
    for (const [id, mesh] of pool) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        pool.delete(id);
      }
    }
  }

  /* ------------------------------------------------------------ *
   *  Chase camera
   * ------------------------------------------------------------ */

  updateCamera(self, dt, lookBack = false) {
    if (!self) return;
    const fx = Math.sin(self.h), fz = Math.cos(self.h);
    const speedPull = Math.min(1, (self.speed ?? 0) / PHYS.MAX_SPEED) * 2.5;
    // Looking back puts the camera IN FRONT of the car, aimed rearward.
    const bs = lookBack ? -1 : 1;
    const dist = 8.5 + speedPull;
    const want = new THREE.Vector3(
      self.x - fx * dist * bs,
      4.6 + self.y * 0.6,
      self.z - fz * dist * bs,
    );
    if (!this.camInit) {
      this.camPos.copy(want);
      this.camInit = true;
    }
    // Snap instantly when toggling the look-back view so the camera
    // doesn't sweep through the car; otherwise smooth normally.
    if (lookBack !== this.wasLookBack) this.camPos.copy(want);
    this.wasLookBack = lookBack;

    // Exponential smoothing keeps the camera fluid at any frame rate.
    const k = 1 - Math.exp(-6 * dt);
    this.camPos.lerp(want, k);

    // Camera shake from nearby explosions.
    const sh = this.effects.shake;
    const jitter = sh > 0
      ? new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh * 0.5, (Math.random() - 0.5) * sh)
      : ZERO;

    this.camera.position.copy(this.camPos).add(jitter);
    this.camLook.set(self.x + fx * 6 * bs, 1.2 + self.y, self.z + fz * 6 * bs);
    this.camera.lookAt(this.camLook);
  }

  /* ------------------------------------------------------------ *
   *  Atmosphere particles: snowstorm (Frozen) / embers (Volcano)
   * ------------------------------------------------------------ */

  buildParticles(mode) {
    const N = 900;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 160;
      pos[i * 3 + 1] = Math.random() * 50;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 160;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = mode === 'snow'
      ? new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, transparent: true, opacity: 0.85 })
      : new THREE.PointsMaterial({ color: 0xff9040, size: 0.3, transparent: true, opacity: 0.8 });
    this.snow = new THREE.Points(geo, mat);
    this.snow.userData.mode = mode;
    this.scene.add(this.snow);
  }

  updateParticles(dt) {
    // Snow falls with sideways wind; embers rise and flutter. The
    // whole field is re-centred on the camera so the effect follows
    // the player everywhere.
    const mode = this.snow.userData.mode;
    const pos = this.snow.geometry.attributes.position;
    const c = this.camera.position;
    for (let i = 0; i < pos.count; i++) {
      let y = mode === 'snow'
        ? pos.getY(i) - dt * (8 + (i % 5))
        : pos.getY(i) + dt * (4 + (i % 4));
      let x = pos.getX(i) + dt * (mode === 'snow' ? 6 : Math.sin(i + y * 0.2) * 2);
      const recycle = mode === 'snow' ? y < 0 : y > 46;
      if (recycle) {
        y = mode === 'snow' ? 45 + Math.random() * 5 : Math.random() * 3;
        x = c.x + (Math.random() - 0.5) * 160;
        pos.setZ(i, c.z + (Math.random() - 0.5) * 160);
      }
      pos.setY(i, y);
      pos.setX(i, x);
    }
    pos.needsUpdate = true;
  }
}

const ZERO = new THREE.Vector3();

/* ==================================================================== *
 *  Mesh factories
 * ==================================================================== */

function makeProjectileMesh(ty) {
  if (ty === 'rocket') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffc86b }));
    glow.position.z = -0.9;
    g.add(glow);
    return g;
  }
  if (ty === 'bouncer') {
    return new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xc86bff }));
  }
  // cluster bomb / bomblet: simple dark sphere
  const r = ty === 'cluster' ? 0.55 : 0.3;
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 10, 8),
    new THREE.MeshBasicMaterial({ color: ty === 'cluster' ? 0x222222 : 0x444444 }));
}

function makeGroundMesh(ty) {
  let mesh;
  if (ty === 'oil') {
    mesh = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 16),
      new THREE.MeshBasicMaterial({ color: 0x0a0a10, transparent: true, opacity: 0.85 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.y = 0.03;
  } else if (ty === 'fire') {
    mesh = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 12),
      new THREE.MeshBasicMaterial({ color: 0xff7a1f, transparent: true, opacity: 0.8 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.y = 0.04;
  } else { // freeze mine
    mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.7),
      new THREE.MeshBasicMaterial({ color: 0x9adfff }));
    mesh.userData.y = 0.7;
  }
  return mesh;
}

/** Floating "name + HP bar" sprite above remote cars. */
function makeTagSprite(name, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(6, 1.5, 1);
  sprite.userData = { cv, tex };
  updateTagSprite(sprite, name, color, 1);
  return sprite;
}

function updateTagSprite(sprite, name, color, hp01) {
  const { cv, tex } = sprite.userData;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.font = 'bold 26px sans-serif';
  c.textAlign = 'center';
  c.fillStyle = '#000000aa';
  c.fillText(name, 129, 29);
  c.fillStyle = color;
  c.fillText(name, 128, 27);
  // HP bar under the name.
  c.fillStyle = '#000a';
  c.fillRect(48, 40, 160, 12);
  c.fillStyle = hp01 > 0.35 ? '#5bde6b' : '#ff5c5c';
  c.fillRect(50, 42, 156 * Math.max(0, Math.min(1, hp01)), 8);
  tex.needsUpdate = true;
}
