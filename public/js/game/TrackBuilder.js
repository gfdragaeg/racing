/**
 * public/js/game/TrackBuilder.js
 * ------------------------------------------------------------------
 * Builds the visual world for a track from the SAME shared track data
 * the server simulates with (shared/tracks.js), so what you see is
 * exactly what you collide with.
 *
 * Everything is deliberately low-poly placeholder art: instanced
 * boxes and cones, emissive circles for hazards, canvas textures for
 * the start line. Gameplay first; art can be swapped in later without
 * touching game logic.
 */

import * as THREE from 'three';
import { inOpenZone } from '/shared/tracks.js';

/** Per-map look: colors, fog, lighting, decoration recipe. */
export const THEMES = {
  downtown: {
    sky: 0x101529, fog: 0x101529, fogFar: 420,
    ground: 0x1b2130, road: 0x353b48, stripe: 0x38e0ff,
    wall: 0x4a5a80, barrierA: 0xd23b3b, barrierB: 0xe8e8e8,
    ambient: 0x99aadd, hemiInt: 1.5, sun: 0xaabbff, sunInt: 1.3,
    dirt: 0x3d434e, horizon: 0x1a2444, stars: 0xffffff,
    decor: 'city',
  },
  volcano: {
    sky: 0x220e08, fog: 0x30120a, fogFar: 330,
    ground: 0x2c1813, road: 0x442e24, stripe: 0xff8b3d,
    wall: 0x5a382a, barrierA: 0x6a4232, barrierB: 0x42281e,
    ambient: 0xff9977, hemiInt: 1.3, sun: 0xffb080, sunInt: 1.1,
    dirt: 0x3a2410, horizon: 0x2c110a, stars: 0xffd0a0,
    decor: 'rocks',
  },
  frozen: {
    sky: 0xbcd4ea, fog: 0xcfe2f2, fogFar: 380,
    ground: 0xe4edf5, road: 0x9fb2c4, stripe: 0x1687ff,
    wall: 0xc4d6e6, barrierA: 0x8fb8d8, barrierB: 0xffffff,
    ambient: 0xffffff, hemiInt: 1.1, sun: 0xfff4e0, sunInt: 1.2,
    dirt: 0xd7e3ee, horizon: 0xf2f8fd, stars: null,
    decor: 'pines',
  },
};

/** Deterministic RNG so decoration is identical for all players. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build all static world geometry for `track` into `scene`.
 * Returns handles the renderer needs for dynamic updates:
 *   pickupMeshes[i], hazardVisuals[hazardIndex], moverMeshes[hazardIndex]
 */
export function buildTrackScene(scene, track) {
  const theme = THEMES[track.theme];
  const group = new THREE.Group();
  group.name = 'track';

  /* ------------------------------ ground --------------------------- */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshLambertMaterial({ color: theme.ground }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  group.add(ground);

  /* ------------------------------- road ---------------------------- */
  group.add(buildRibbon(track, track.halfWidth, 0.0, theme.road));
  // Bright edge stripes so the road reads at speed.
  group.add(buildStripe(track, track.halfWidth - 0.35, theme.stripe));
  group.add(buildStripe(track, -(track.halfWidth - 0.35), theme.stripe));

  // Open zones (shortcut corridors) get a distinct DIRT floor: it
  // shows players where the wall gap is AND reads as "this surface is
  // slower" (the off-road mud penalty applies out here). Tiny per-
  // circle height offsets avoid z-fighting where circles overlap.
  const zoneMat = new THREE.MeshLambertMaterial({ color: theme.dirt });
  track.openZones.forEach((zn, zi) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(zn.r, 20), zoneMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(zn.x, 0.008 + zi * 0.0007, zn.z);
    group.add(m);
  });

  /* ------------------------------- walls ---------------------------- */
  group.add(buildWalls(track, theme));
  group.add(buildCenterDashes(track));

  /* ------------------------ theme centrepieces ---------------------- */
  if (track.theme === 'downtown') group.add(buildStreetLights(track));
  if (track.theme === 'volcano') group.add(buildVolcanoCone());

  /* --------------------- horizon & sky dressing --------------------- */
  group.add(buildHorizon(theme));
  if (theme.stars) group.add(buildStars(theme.stars));
  group.add(buildGroundPatches(track, theme));

  /* ---------------------------- start line -------------------------- */
  group.add(buildStartLine(track));

  /* ----------------------------- boost pads ------------------------- */
  for (const pad of track.boostPads) {
    const isRamp = pad.type === 'ramp';
    const mesh = new THREE.Mesh(
      isRamp
        ? new THREE.BoxGeometry(5, 0.7, 6)
        : new THREE.PlaneGeometry(4.5, 4.5),
      new THREE.MeshLambertMaterial({
        color: isRamp ? 0xff8b3d : 0x0aa7c8,
        emissive: isRamp ? 0x672c08 : 0x0a5566,
      }),
    );
    const yaw = Math.atan2(pad.dirX, pad.dirZ);
    if (isRamp) {
      mesh.position.set(pad.x, 0.15, pad.z);
      mesh.rotation.y = yaw;
      mesh.rotation.x = -0.10; // slight wedge tilt
    } else {
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -yaw;
      mesh.position.set(pad.x, 0.03, pad.z);
    }
    group.add(mesh);
  }

  /* ------------------------------ pickups --------------------------- */
  const pickupMeshes = track.pickups.map((pk) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 1.7, 1.7),
      new THREE.MeshLambertMaterial({ color: 0xffd24d, emissive: 0x554411 }),
    );
    m.position.set(pk.x, 1.4, pk.z);
    group.add(m);
    return m;
  });

  /* ------------------------------ hazards --------------------------- */
  const hazardVisuals = {};
  const moverMeshes = {};
  for (const h of track.hazards) {
    if (h.type === 'lava') {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(h.r, 22),
        new THREE.MeshBasicMaterial({ color: 0xff5a1f }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(h.x, 0.02, h.z);
      group.add(m);
      hazardVisuals[h.i] = { lava: m };
    } else if (h.type === 'slick') {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(h.r, 22),
        new THREE.MeshBasicMaterial({ color: 0x9adfff, transparent: true, opacity: 0.35 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(h.x, 0.02, h.z);
      group.add(m);
    } else if (h.type === 'rocks' || h.type === 'collapse') {
      // Warning ring shown during the 'warn' phase...
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(h.r - 0.7, h.r, 26),
        new THREE.MeshBasicMaterial({ color: 0xff3030, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(h.x, 0.04, h.z);
      ring.visible = false;
      group.add(ring);
      // ...and the danger itself during 'active'.
      const danger = h.type === 'rocks'
        ? new THREE.Mesh(
            new THREE.ConeGeometry(h.r * 0.6, 3, 7),
            new THREE.MeshLambertMaterial({ color: 0x54382a }))
        : new THREE.Mesh(
            new THREE.CircleGeometry(h.r, 22),
            new THREE.MeshBasicMaterial({ color: 0x140a06 }));
      if (h.type === 'rocks') danger.position.set(h.x, 1.5, h.z);
      else { danger.rotation.x = -Math.PI / 2; danger.position.set(h.x, 0.05, h.z); }
      danger.visible = false;
      group.add(danger);
      hazardVisuals[h.i] = { ring, danger, type: h.type };
    } else if (h.type === 'mover') {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(h.r * 1.8, 3.5, h.r * 1.8),
        new THREE.MeshLambertMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.85 }),
      );
      m.position.set(h.x0, 1.7, h.z0);
      group.add(m);
      moverMeshes[h.i] = m;
    }
  }

  /* --------------------------- tunnels / caves ---------------------- */
  for (const tun of track.tunnels) {
    for (let s = tun.from; s < tun.to; s += 0.012) {
      const w = track.worldAt(s, 0);
      const arch = makeArch(track.halfWidth, theme);
      arch.position.set(w.x, 0, w.z);
      arch.rotation.y = Math.atan2(w.dirX, w.dirZ);
      group.add(arch);
    }
  }

  /* ------------------------------ decoration ------------------------ */
  group.add(buildDecor(track, theme));
  group.add(buildRoadsideProps(track, theme));

  scene.add(group);
  return { group, pickupMeshes, hazardVisuals, moverMeshes, theme };
}

/* ==================================================================== *
 *  Geometry helpers
 * ==================================================================== */

/** Flat ribbon that follows the centreline at ±width. */
function buildRibbon(track, width, y, color) {
  const pts = track.pts, n = pts.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n];
    const rx = p.dirZ, rz = -p.dirX;
    pos.set([p.x - rx * width, y, p.z - rz * width], i * 6);
    pos.set([p.x + rx * width, y, p.z + rz * width], i * 6 + 3);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
}

/** Thin bright line following the centreline at lateral offset `lat`. */
function buildStripe(track, lat, color) {
  const pts = track.pts, n = pts.length;
  const HALF = 0.22;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n];
    const rx = p.dirZ, rz = -p.dirX;
    const cx = p.x + rx * lat, cz = p.z + rz * lat;
    pos.set([cx - rx * HALF, 0.02, cz - rz * HALF], i * 6);
    pos.set([cx + rx * HALF, 0.02, cz + rz * HALF], i * 6 + 3);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
}

/**
 * F1-style two-tone barrier walls along both edges.
 *
 * Rails are per-sample (short segments) and a rail is dropped if ANY
 * part of it touches an open zone — so a rail you can SEE is always a
 * rail you can HIT. (Coarser rails previously overhung shortcut
 * openings, which looked like cars clipping through solid railings.)
 */
function buildWalls(track, theme) {
  const pts = track.pts, n = pts.length;
  const segsA = [], segsB = []; // alternating colour groups
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    for (const side of [-1, 1]) {
      const off = track.halfWidth + 0.5;
      const x1 = p.x + p.dirZ * side * off, z1 = p.z - p.dirX * side * off;
      const x2 = q.x + q.dirZ * side * off, z2 = q.z - q.dirX * side * off;
      if (inOpenZone(track, x1, z1) || inOpenZone(track, x2, z2) ||
          inOpenZone(track, (x1 + x2) / 2, (z1 + z2) / 2)) continue;
      (i % 2 ? segsA : segsB).push({
        x: (x1 + x2) / 2, z: (z1 + z2) / 2,
        yaw: Math.atan2(p.dirX, p.dirZ), len: p.segLen * 1.12,
      });
    }
  }

  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1.1, 1);
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [segs, color] of [[segsA, theme.barrierA], [segsB, theme.barrierB]]) {
    const inst = new THREE.InstancedMesh(
      geo, new THREE.MeshLambertMaterial({ color }), segs.length);
    segs.forEach((b, i) => {
      quat.setFromAxisAngle(up, b.yaw);
      m4.compose(new THREE.Vector3(b.x, 0.55, b.z), quat, new THREE.Vector3(0.9, 1, b.len));
      inst.setMatrixAt(i, m4);
    });
    group.add(inst);
  }
  return group;
}

/** Dashed white centreline — a huge legibility win at speed. */
function buildCenterDashes(track) {
  const pts = track.pts, n = pts.length;
  const dashes = [];
  for (let i = 0; i < n; i += 3) {
    const p = pts[i];
    dashes.push({ x: p.x, z: p.z, yaw: Math.atan2(p.dirX, p.dirZ), len: p.segLen * 1.4 });
  }
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.25, 0.02, 1),
    new THREE.MeshBasicMaterial({ color: 0xcccccc }),
    dashes.length);
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  dashes.forEach((d, i) => {
    quat.setFromAxisAngle(up, d.yaw);
    m4.compose(new THREE.Vector3(d.x, 0.02, d.z), quat, new THREE.Vector3(1, 1, d.len));
    inst.setMatrixAt(i, m4);
  });
  return inst;
}

/** Street lights along the road (Downtown): poles + glowing heads. */
function buildStreetLights(track) {
  const pts = track.pts, n = pts.length;
  const spots = [];
  for (let i = 0; i < n; i += 8) {
    const p = pts[i];
    const side = (i / 8) % 2 ? 1 : -1; // alternate sides
    const off = track.halfWidth + 2.2;
    const x = p.x + p.dirZ * side * off, z = p.z - p.dirX * side * off;
    if (inOpenZone(track, x, z)) continue;
    spots.push({ x, z });
  }
  const group = new THREE.Group();
  const poles = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.18, 5.2, 0.18),
    new THREE.MeshLambertMaterial({ color: 0x39415a }), spots.length);
  const heads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.35, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8 }), spots.length);
  const m4 = new THREE.Matrix4();
  spots.forEach((s, i) => {
    poles.setMatrixAt(i, m4.makeTranslation(s.x, 2.6, s.z));
    heads.setMatrixAt(i, m4.makeTranslation(s.x, 5.3, s.z));
  });
  group.add(poles, heads);
  return group;
}

/** The volcano itself: a huge cone with a glowing crater, mid-island. */
function buildVolcanoCone() {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(52, 66, 9),
    new THREE.MeshLambertMaterial({ color: 0x2e1a12 }));
  cone.position.set(0, 33, 0);
  g.add(cone);
  const crater = new THREE.Mesh(
    new THREE.SphereGeometry(9, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff6a20 }));
  crater.position.set(0, 64, 0);
  g.add(crater);
  const glow = new THREE.PointLight(0xff5a1f, 350, 220);
  glow.position.set(0, 70, 0);
  g.add(glow);
  // Glowing lava streams running down the flanks. Each stream lives in
  // a yaw pivot so the downhill tilt stays a simple X rotation.
  const streamMat = new THREE.MeshBasicMaterial({ color: 0xff6a20 });
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = i * (Math.PI / 2) + 0.45;
    const stream = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 36), streamMat);
    stream.position.set(0, 34, 25);
    stream.rotation.x = 0.9; // ≈ the cone's slope angle
    pivot.add(stream);
    g.add(pivot);
  }
  return g;
}

/**
 * Distant horizon silhouettes rendered with fog disabled, so the flat
 * fog-coloured edge of the world becomes a skyline (Downtown), a
 * mountain ridge (Volcano) or white peaks (Frozen).
 */
function buildHorizon(theme) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: theme.horizon, fog: false });
  const rnd = mulberry32(24680);
  const N = theme.decor === 'city' ? 26 : 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rnd() * 0.25;
    const dist = 430 + rnd() * 70;
    let mesh;
    if (theme.decor === 'city') {
      const w = 26 + rnd() * 40, h = 55 + rnd() * 100;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
      mesh.position.set(Math.sin(a) * dist, h / 2 - 2, Math.cos(a) * dist);
    } else {
      const r = 55 + rnd() * 50, h = 75 + rnd() * 95;
      mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat);
      mesh.position.set(Math.sin(a) * dist, h / 2 - 3, Math.cos(a) * dist);
    }
    g.add(mesh);
  }
  return g;
}

/** Static star dome for the night maps (fog-exempt point sprites). */
function buildStars(color) {
  const N = 450;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = 0.06 + Math.random() * Math.PI * 0.46; // elevation above horizon
    const r = 640;
    pos[i * 3] = Math.cos(e) * Math.sin(a) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.cos(e) * Math.cos(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color, size: 1.6, sizeAttenuation: false, fog: false,
    transparent: true, opacity: 0.85,
  }));
}

/**
 * Large flat patches on the terrain outside the road: lava pools on
 * Volcano, frozen ponds on Frozen Summit. Downtown skips these.
 */
function buildGroundPatches(track, theme) {
  const g = new THREE.Group();
  if (theme.decor === 'city') return g;
  const rnd = mulberry32(555777);
  const isLava = theme.decor === 'rocks';
  const mat = isLava
    ? new THREE.MeshBasicMaterial({ color: 0xff5a1f })
    : new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.85 });

  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of track.pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  let placed = 0, guard = 0;
  while (placed < (isLava ? 9 : 6) && guard++ < 200) {
    const x = minX - 60 + rnd() * (maxX - minX + 120);
    const z = minZ - 60 + rnd() * (maxZ - minZ + 120);
    // keep clear of the road and shortcut corridors
    let near = 1e9;
    for (let i = 0; i < track.pts.length; i += 3) {
      const dx = x - track.pts[i].x, dz = z - track.pts[i].z;
      near = Math.min(near, dx * dx + dz * dz);
    }
    if (Math.sqrt(near) < track.halfWidth + 12 || inOpenZone(track, x, z)) continue;
    const r = isLava ? 5 + rnd() * 9 : 9 + rnd() * 13;
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 18), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.006, z);
    g.add(m);
    placed++;
  }
  return g;
}

/** Checkered start/finish line across the road plus two gate posts. */
function buildStartLine(track) {
  const g = new THREE.Group();
  const w = track.worldAt(0, 0);
  const yaw = Math.atan2(w.dirX, w.dirZ);

  // Checkerboard canvas texture — the only "texture" in the game.
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 32;
  const c = cv.getContext('2d');
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 2; y++) {
      c.fillStyle = (x + y) % 2 ? '#fff' : '#111';
      c.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(track.halfWidth * 2, 3),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = -yaw;
  line.position.set(w.x, 0.03, w.z);
  g.add(line);

  // Gate posts on both sides.
  const postMat = new THREE.MeshLambertMaterial({ color: 0xdddddd });
  for (const side of [-1, 1]) {
    const rx = w.dirZ, rz = -w.dirX;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), postMat);
    post.position.set(
      w.x + rx * side * (track.halfWidth + 1), 3.5,
      w.z + rz * side * (track.halfWidth + 1),
    );
    g.add(post);
  }
  return g;
}

/** A single tunnel/cave arch: two pillars + a lintel. */
function makeArch(halfWidth, theme) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: theme.wall });
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 6, 1.2), mat);
    pillar.position.set(side * (halfWidth + 1.2), 3, 0);
    g.add(pillar);
  }
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(halfWidth * 2 + 4.5, 1.2, 1.6), mat);
  top.position.y = 6.2;
  g.add(top);
  return g;
}

/**
 * Small props scattered CLOSE to the road (8–18 m out) so the roadside
 * doesn't feel empty between the big background decor: glowing lava
 * rocks on Volcano, ice shards on Frozen, hydrant-ish bollards Downtown.
 */
function buildRoadsideProps(track, theme) {
  const rnd = mulberry32(987654);
  const COUNT = 70;
  const pts = track.pts, n = pts.length;
  const spots = [];
  let guard = 0;
  while (spots.length < COUNT && guard++ < COUNT * 20) {
    const p = pts[Math.floor(rnd() * n)];
    const side = rnd() > 0.5 ? 1 : -1;
    const off = track.halfWidth + 6 + rnd() * 12;
    const x = p.x + p.dirZ * side * off, z = p.z - p.dirX * side * off;
    if (inOpenZone(track, x, z)) continue;
    spots.push({ x, z, r: rnd() });
  }

  let geo, mat;
  if (theme.decor === 'city') {
    geo = new THREE.BoxGeometry(0.7, 1.1, 0.7);
    mat = new THREE.MeshLambertMaterial({ color: 0x5a6a90 });
  } else if (theme.decor === 'rocks') {
    geo = new THREE.DodecahedronGeometry(0.8);
    mat = new THREE.MeshBasicMaterial({ color: 0xff7a30 }); // glowing embers
  } else {
    geo = new THREE.OctahedronGeometry(0.9);
    mat = new THREE.MeshLambertMaterial({ color: 0xd8f0ff });
  }
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  spots.forEach((sp, i) => {
    quat.setFromAxisAngle(up, sp.r * Math.PI * 2);
    const s = 0.7 + sp.r * 1.1;
    m4.compose(new THREE.Vector3(sp.x, 0.5 * s, sp.z), quat, new THREE.Vector3(s, s, s));
    inst.setMatrixAt(i, m4);
  });
  return inst;
}

/**
 * Window textures for the city buildings: `map` carries the wall +
 * window colours (multiplied by each instance's tint), `glow` is an
 * emissive mask so lit windows shine through the night fog.
 */
function makeWindowTextures() {
  const mapCv = document.createElement('canvas');
  mapCv.width = 64; mapCv.height = 128;
  const mc = mapCv.getContext('2d');
  const glowCv = document.createElement('canvas');
  glowCv.width = 64; glowCv.height = 128;
  const gc = glowCv.getContext('2d');

  mc.fillStyle = '#8a8f9c'; // wall base — instance colour tints this
  mc.fillRect(0, 0, 64, 128);
  gc.fillStyle = '#000';
  gc.fillRect(0, 0, 64, 128);

  for (let y = 6; y < 120; y += 10) {
    for (let x = 5; x < 56; x += 10) {
      const lit = Math.random() < 0.45;
      mc.fillStyle = lit ? '#ffe9a0' : '#20242e';
      mc.fillRect(x, y, 6, 6);
      if (lit) { gc.fillStyle = '#c9a24f'; gc.fillRect(x, y, 6, 6); }
    }
  }
  const map = new THREE.CanvasTexture(mapCv);
  const glow = new THREE.CanvasTexture(glowCv);
  map.magFilter = glow.magFilter = THREE.NearestFilter;
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, glow };
}

/** Theme-specific scatter decoration, kept clear of the road. */
function buildDecor(track, theme) {
  const rnd = mulberry32(1234567);
  const COUNT = 160;

  // Compute a loose bounding box around the track.
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of track.pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 90;

  // Distance from a point to the nearest track sample (coarse but fine
  // for placement) — rejects spots on or near the road.
  const clearOfRoad = (x, z) => {
    if (inOpenZone(track, x, z)) return false;
    let best = 1e9;
    for (let i = 0; i < track.pts.length; i += 2) {
      const dx = x - track.pts[i].x, dz = z - track.pts[i].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best) > track.halfWidth + 7;
  };

  const spots = [];
  let guard = 0;
  while (spots.length < COUNT && guard++ < COUNT * 30) {
    const x = minX - pad + rnd() * (maxX - minX + pad * 2);
    const z = minZ - pad + rnd() * (maxZ - minZ + pad * 2);
    if (clearOfRoad(x, z)) spots.push({ x, z, r: rnd() });
  }

  const geo = theme.decor === 'city'
    ? new THREE.BoxGeometry(1, 1, 1)
    : new THREE.ConeGeometry(0.6, 1, 6);
  // City buildings get a lit-window texture (map tints per instance,
  // the emissive map makes windows glow through the night fog).
  let mat;
  if (theme.decor === 'city') {
    const { map, glow } = makeWindowTextures();
    mat = new THREE.MeshLambertMaterial({
      color: 0xffffff, map,
      emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 0.6,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  }
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  spots.forEach((sp, i) => {
    let sx, sy, sz, col;
    if (theme.decor === 'city') {
      sx = 8 + sp.r * 14; sz = 8 + ((sp.r * 7919) % 1) * 14;
      sy = 8 + sp.r * 34;
      col = color.setHSL(0.62, 0.25, 0.17 + sp.r * 0.15);
    } else if (theme.decor === 'rocks') {
      sx = sz = 4 + sp.r * 9; sy = 4 + sp.r * 12;
      col = color.setHSL(0.05, 0.35, 0.12 + sp.r * 0.1);
    } else { // pines
      sx = sz = 3 + sp.r * 4; sy = 6 + sp.r * 8;
      col = color.setHSL(0.38, 0.35, 0.22 + sp.r * 0.15);
    }
    q.setFromAxisAngle(up, sp.r * Math.PI * 2);
    m4.compose(new THREE.Vector3(sp.x, sy / 2, sp.z), q, new THREE.Vector3(sx, sy, sz));
    inst.setMatrixAt(i, m4);
    inst.setColorAt(i, col);
  });
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}
