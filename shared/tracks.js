/**
 * shared/tracks.js
 * ------------------------------------------------------------------
 * Data-driven track system, shared by server and client.
 *
 * A track is authored as a closed loop of control points (generated
 * from a "radial loop" recipe, which guarantees the loop never
 * self-intersects). The loop is smoothed with a Catmull-Rom spline
 * into a dense polyline of samples. Everything else — checkpoints,
 * spawn grid, boost pads, pickup crates, hazards, shortcuts — is
 * authored as fractions of lap distance (`s` in [0,1)) plus a lateral
 * offset, and resolved into world coordinates at build time.
 *
 * The SERVER uses the samples for wall collision, lap/checkpoint
 * logic, hazards and pickups. The CLIENT uses the exact same data to
 * build the Three.js road mesh, so visuals and physics always match.
 *
 * Coordinate system: X/Z ground plane, Y up. Heading 0 faces +Z.
 */

import { PHYS, clamp, wrapAngle } from './constants.js';

/* ================================================================== *
 *  Geometry helpers
 * ================================================================== */

/**
 * Build control points for a star-shaped ("radial") closed loop.
 * Because every point sits at a unique angle around the origin, the
 * resulting loop can never cross itself — safe procedural authoring.
 */
function radialLoop(radii, scaleX = 1, scaleZ = 1) {
  const n = radii.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.sin(a) * radii[i] * scaleX, Math.cos(a) * radii[i] * scaleZ]);
  }
  return pts;
}

/** Sample a closed Catmull-Rom spline through `ctrl` points. */
function sampleClosedSpline(ctrl, perSegment = 16) {
  const n = ctrl.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n];
    const p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < perSegment; j++) {
      const t = j / perSegment, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const z = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push({ x, z });
    }
  }
  return out;
}

/** Annotate samples with direction vectors and cumulative distance. */
function measureLoop(samples) {
  const n = samples.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i], b = samples[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    a.dirX = dx / len;
    a.dirZ = dz / len;
    a.segLen = len;
    a.d = total;         // arc distance from start line to this sample
    total += len;
  }
  return total;
}

/* ================================================================== *
 *  Track definitions
 * ================================================================== */

/** Metadata surfaced in the lobby UI. */
export const TRACK_INFO = {
  downtown: { name: 'Downtown Circuit', difficulty: 'Beginner', blurb: 'Wide city streets, boost pads, tunnels and alley shortcuts.' },
  volcano:  { name: 'Volcano Run',      difficulty: 'Hard',     blurb: 'Narrow road with lava, falling rocks, a collapsing bridge and bottomless pits — fall in and you restart the lap!' },
  frozen:   { name: 'Frozen Summit',    difficulty: 'Tricky',   blurb: 'Low-grip ice, a frozen-lake shortcut, moving glaciers and snowstorms.' },
  toxic:    { name: 'Toxic Waste',      difficulty: 'Hard',     blurb: 'Radioactive sludge, toxic-waste pools and slippery ooze in an abandoned chemical plant.' },
};
export const TRACK_IDS = Object.keys(TRACK_INFO);

/**
 * Raw per-track recipes. All positional features use `s` (0..1
 * fraction of lap distance) + `lat` (metres left(-)/right(+) of the
 * centreline) so they survive geometry tweaks.
 */
const TRACK_DEFS = {
  downtown: {
    theme: 'downtown',
    ctrl: radialLoop([150, 140, 146, 152, 138, 150, 156, 142, 150, 156, 140, 148], 1.18, 0.95),
    halfWidth: 10,
    baseGrip: 1.0,
    checkpoints: 8,
    // Alley shortcuts: drivable corridors that cut a corner of the loop.
    shortcuts: [
      { a: 0.10, b: 0.215, w: 11 },
      { a: 0.555, b: 0.675, w: 11 },
    ],
    // Driving off the paved ribbon (in shortcut zones) hits this
    // penalty: rough back-alley concrete.
    offRoad: { accelMul: 0.7, maxMul: 0.75, grip: 1.0 },
    boostPads: [
      { s: 0.06, lat: 0, type: 'boost' }, { s: 0.30, lat: -3, type: 'boost' },
      { s: 0.48, lat: 0, type: 'ramp' },  { s: 0.72, lat: 3, type: 'boost' },
      { s: 0.90, lat: 0, type: 'boost' },
    ],
    pickupRows: [
      { s: 0.14, lats: [-5, 0, 5] }, { s: 0.27, lats: [-5, 0, 5] },
      { s: 0.40, lats: [-5, 0, 5] }, { s: 0.52, lats: [-5, 0, 5] },
      { s: 0.64, lats: [-5, 0, 5] }, { s: 0.78, lats: [-5, 0, 5] },
      { s: 0.86, lats: [-5, 0, 5] },
    ],
    hazards: [],
    // Client-only dressing: tunnel arches over a stretch of road.
    tunnels: [{ from: 0.33, to: 0.40 }],
  },

  volcano: {
    theme: 'volcano',
    ctrl: radialLoop([122, 82, 126, 86, 130, 78, 120, 90, 128, 82, 118, 88, 126, 84]),
    halfWidth: 6,
    baseGrip: 1.0,
    checkpoints: 8,
    // Risky lava-field shortcuts (lava pools are placed inside them).
    shortcuts: [
      { a: 0.055, b: 0.16, w: 10 },
      { a: 0.62, b: 0.72, w: 10 },
    ],
    // Volcanic MUD/ash off the road: heavy slowdown — the lava-field
    // shortcuts are a genuine gamble now.
    offRoad: { accelMul: 0.55, maxMul: 0.6, grip: 0.8 },
    boostPads: [
      { s: 0.24, lat: 0, type: 'boost' }, { s: 0.52, lat: 0, type: 'ramp' },
      { s: 0.80, lat: 0, type: 'boost' },
    ],
    pickupRows: [
      { s: 0.12, lats: [-3, 0, 3] }, { s: 0.20, lats: [-3, 0, 3] },
      { s: 0.33, lats: [-3, 0, 3] }, { s: 0.47, lats: [-3, 0, 3] },
      { s: 0.60, lats: [-3, 0, 3] }, { s: 0.76, lats: [-3, 0, 3] },
      { s: 0.94, lats: [-3, 0, 3] },
    ],
    hazards: [
      // Lava pools encroaching onto the road edge...
      { type: 'lava', s: 0.28, lat: 5, r: 4, dps: 22 },
      { type: 'lava', s: 0.44, lat: -5, r: 4, dps: 22 },
      { type: 'lava', s: 0.86, lat: 5, r: 4, dps: 22 },
      // ...and pools inside the shortcut corridors (risk vs reward).
      { type: 'lava', s: 0.105, lat: -26, r: 7, dps: 22 },
      { type: 'lava', s: 0.67, lat: -24, r: 7, dps: 22 },
      // Falling rock zones: warn, then slam down periodically.
      { type: 'rocks', s: 0.35, lat: 0, r: 5, period: 6, warn: 1.5, active: 0.7, dps: 55 },
      { type: 'rocks', s: 0.90, lat: 2, r: 5, period: 7, warn: 1.5, active: 0.7, dps: 55 },
      // Collapsing bridge: a longer zone that periodically gives way.
      { type: 'collapse', s: 0.575, lat: 0, r: 9, period: 9, warn: 2.0, active: 2.0, dps: 35 },
      // Bottomless pits: offset to one side so there's a lane to thread
      // (or hop over with SHIFT). Fall in and you restart the CURRENT lap.
      { type: 'hole', s: 0.19, lat: 3, r: 2.6 },
      { type: 'hole', s: 0.41, lat: -3, r: 2.6 },
      { type: 'hole', s: 0.83, lat: 3, r: 2.6 },
    ],
    tunnels: [],
  },

  frozen: {
    theme: 'frozen',
    ctrl: radialLoop([132, 112, 142, 106, 136, 102, 142, 116, 132, 102, 136, 112], 1.0, 1.15),
    halfWidth: 8,
    baseGrip: 0.55, // everything is icy
    checkpoints: 8,
    // Frozen-lake shortcut: fast line, but nearly zero grip out there.
    shortcuts: [
      { a: 0.30, b: 0.445, w: 13 },
      { a: 0.79, b: 0.88, w: 11 },
    ],
    // Deep snow off the road: mild slowdown but very little grip.
    offRoad: { accelMul: 0.8, maxMul: 0.85, grip: 0.6 },
    boostPads: [
      { s: 0.12, lat: 0, type: 'boost' }, { s: 0.50, lat: 0, type: 'boost' },
      { s: 0.68, lat: 0, type: 'ramp' },  { s: 0.93, lat: 0, type: 'boost' },
    ],
    pickupRows: [
      { s: 0.10, lats: [-4, 0, 4] }, { s: 0.18, lats: [-4, 0, 4] },
      { s: 0.30, lats: [-4, 0, 4] }, { s: 0.42, lats: [-4, 0, 4] },
      { s: 0.54, lats: [-4, 0, 4] }, { s: 0.70, lats: [-4, 0, 4] },
      { s: 0.88, lats: [-4, 0, 4] },
    ],
    hazards: [
      // Ultra-slick patches on the racing line.
      { type: 'slick', s: 0.26, lat: 0, r: 6, grip: 0.28 },
      { type: 'slick', s: 0.57, lat: -2, r: 6, grip: 0.28 },
      // The lake itself is one big slick zone (inside the shortcut).
      { type: 'slick', s: 0.372, lat: -30, r: 22, grip: 0.22 },
      // Moving glaciers slide back and forth across the road.
      { type: 'mover', s: 0.22, span: 1.8, period: 5, r: 3.2, dmg: 12 },
      { type: 'mover', s: 0.74, span: 1.8, period: 6.5, r: 3.2, dmg: 12 },
    ],
    // Reused as "ice cave" arches on this map.
    tunnels: [{ from: 0.60, to: 0.66 }],
  },

  toxic: {
    theme: 'toxic',
    ctrl: radialLoop([128, 108, 134, 100, 138, 104, 126, 112, 136, 100, 130, 110], 1.1, 1.0),
    halfWidth: 8,
    baseGrip: 0.9, // faint ooze on the tarmac
    checkpoints: 8,
    // Sludge-field shortcuts (toxic pools lurk inside them).
    shortcuts: [
      { a: 0.20, b: 0.32, w: 12 },
      { a: 0.70, b: 0.80, w: 11 },
    ],
    // Thick sludge off the road: heavy slowdown.
    offRoad: { accelMul: 0.6, maxMul: 0.7, grip: 0.7 },
    boostPads: [
      { s: 0.10, lat: 0, type: 'boost' }, { s: 0.45, lat: 0, type: 'ramp' },
      { s: 0.60, lat: 0, type: 'boost' }, { s: 0.88, lat: 0, type: 'boost' },
    ],
    pickupRows: [
      { s: 0.08, lats: [-4, 0, 4] }, { s: 0.18, lats: [-4, 0, 4] },
      { s: 0.36, lats: [-4, 0, 4] }, { s: 0.50, lats: [-4, 0, 4] },
      { s: 0.62, lats: [-4, 0, 4] }, { s: 0.78, lats: [-4, 0, 4] },
      { s: 0.92, lats: [-4, 0, 4] },
    ],
    hazards: [
      // Toxic-waste pools eating into the road edge (damage over time).
      { type: 'toxic', s: 0.14, lat: 4, r: 4, dps: 18 },
      { type: 'toxic', s: 0.38, lat: -4, r: 4, dps: 18 },
      { type: 'toxic', s: 0.55, lat: 4, r: 4, dps: 18 },
      { type: 'toxic', s: 0.84, lat: -4, r: 4, dps: 18 },
      // Big pools inside the sludge shortcuts (risk vs reward).
      { type: 'toxic', s: 0.26, lat: -26, r: 8, dps: 18 },
      { type: 'toxic', s: 0.75, lat: 24, r: 8, dps: 18 },
      // Radioactive slick patches on the racing line.
      { type: 'slick', s: 0.48, lat: 0, r: 6, grip: 0.4 },
      { type: 'slick', s: 0.95, lat: -2, r: 6, grip: 0.4 },
    ],
    // Reused as a big rusty pipe over the road.
    tunnels: [{ from: 0.63, to: 0.69 }],
  },
};

/* ================================================================== *
 *  Track building
 * ================================================================== */

const builtCache = new Map();

/** World position of the centreline point at lap-fraction `s`, offset `lat`. */
function worldAtRaw(pts, total, s, lat) {
  const d = ((s % 1) + 1) % 1 * total;
  // Samples are near-uniform, so estimate then walk to the right segment.
  let i = Math.floor((d / total) * pts.length) % pts.length;
  while (pts[(i + 1) % pts.length].d > pts[i].d && pts[(i + 1) % pts.length].d <= d) i = (i + 1) % pts.length;
  const p = pts[i];
  const t = clamp((d - p.d) / p.segLen, 0, 1);
  const q = pts[(i + 1) % pts.length];
  const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
  // right-hand normal of the direction vector
  const rx = p.dirZ, rz = -p.dirX;
  return { x: x + rx * lat, z: z + rz * lat, dirX: p.dirX, dirZ: p.dirZ, idx: i };
}

/**
 * Build (and cache) the full runtime track object for a track id.
 * This is the single source of truth used by physics, game rules and
 * rendering.
 */
export function buildTrack(id) {
  if (builtCache.has(id)) return builtCache.get(id);
  const def = TRACK_DEFS[id];
  if (!def) throw new Error(`Unknown track: ${id}`);

  const pts = sampleClosedSpline(def.ctrl, 16);
  const total = measureLoop(pts);
  const wAt = (s, lat) => worldAtRaw(pts, total, s, lat);

  /* --- checkpoints: evenly spaced sample indices; cp 0 = start line --- */
  const cpS = [];
  const cpIdx = [];
  for (let k = 0; k < def.checkpoints; k++) {
    const s = k / def.checkpoints;
    cpS.push(s);
    cpIdx.push(wAt(s, 0).idx);
  }

  /* --- spawn grid: 2 columns x 4 rows just AFTER the start line so the
         first checkpoint everyone chases is cp 1 (see Game.js) --- */
  const spawns = [];
  for (let slot = 0; slot < 8; slot++) {
    const row = Math.floor(slot / 2);
    const col = slot % 2;
    const s = 0.028 - row * 0.007; // pole position furthest ahead
    const lat = (col === 0 ? -1 : 1) * def.halfWidth * 0.4;
    const w = wAt(s, lat);
    spawns.push({ x: w.x, z: w.z, h: Math.atan2(w.dirX, w.dirZ), s });
  }

  /* --- shortcuts become chains of overlapping "open zones": circles in
         which the track wall constraint is suspended.
         IMPORTANT: the corridor is anchored at the road EDGE facing the
         other end, not the road centre. Centre-anchored circles used to
         reach across narrow roads (Volcano!) and silently disable the
         OPPOSITE railing's collision while it still rendered — letting
         cars clip straight through an intact-looking wall. --- */
  const openZones = [];
  for (const sc of def.shortcuts) {
    const A0 = wAt(sc.a, 0), B0 = wAt(sc.b, 0);
    // Signed lateral offset pointing from `from` toward `to`.
    const edgeLat = (from, to) => {
      const rx = from.dirZ, rz = -from.dirX;
      const side = Math.sign((to.x - from.x) * rx + (to.z - from.z) * rz) || 1;
      return side * def.halfWidth * 0.7;
    };
    const A = wAt(sc.a, edgeLat(A0, B0));
    const B = wAt(sc.b, edgeLat(B0, A0));
    const dist = Math.hypot(B.x - A.x, B.z - A.z);
    const steps = Math.max(2, Math.ceil(dist / sc.w));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      openZones.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t, r: sc.w });
    }
  }

  /* --- resolve boost pads / pickups / hazards into world space --- */
  const boostPads = def.boostPads.map((b, i) => {
    const w = wAt(b.s, b.lat);
    return { i, type: b.type, x: w.x, z: w.z, dirX: w.dirX, dirZ: w.dirZ, r: 3.4 };
  });

  const pickups = [];
  for (const row of def.pickupRows) {
    for (const lat of row.lats) {
      const w = wAt(row.s, lat);
      pickups.push({ i: pickups.length, x: w.x, z: w.z });
    }
  }

  const hazards = def.hazards.map((h, i) => {
    const base = { i, type: h.type, r: h.r, dps: h.dps || 0 };
    if (h.type === 'mover') {
      // Glacier slides between the two road edges (and a bit beyond).
      const A = wAt(h.s, -def.halfWidth * h.span);
      const B = wAt(h.s, +def.halfWidth * h.span);
      return { ...base, x0: A.x, z0: A.z, x1: B.x, z1: B.z, period: h.period, dmg: h.dmg };
    }
    const w = wAt(h.s, h.lat);
    return {
      ...base, x: w.x, z: w.z,
      period: h.period, warn: h.warn, active: h.active,
      grip: h.grip, phase: (i * 1.7) % (h.period || 1),
    };
  });

  const track = {
    id,
    theme: def.theme,
    pts,
    total,
    halfWidth: def.halfWidth,
    baseGrip: def.baseGrip,
    offRoad: def.offRoad,
    cpS, cpIdx,
    numCps: def.checkpoints,
    spawns,
    openZones,
    boostPads,
    pickups,
    hazards,
    tunnels: def.tunnels,
    worldAt: wAt,
  };
  builtCache.set(id, track);
  return track;
}

/* ================================================================== *
 *  Runtime queries (used by physics on both sides, every tick)
 * ================================================================== */

/** Is a world point inside any open (shortcut) zone? */
export function inOpenZone(track, x, z) {
  for (const zn of track.openZones) {
    const dx = x - zn.x, dz = z - zn.z;
    if (dx * dx + dz * dz < zn.r * zn.r) return true;
  }
  return false;
}

/**
 * Locate a world point relative to the track centreline.
 * Uses `hintIdx` (the sample found last tick) to search only a small
 * window; falls back to a full scan when the hint is clearly wrong
 * (e.g. after cutting across a shortcut corridor).
 *
 * Returns { idx, px, pz, dirX, dirZ, lat, s, dist }:
 *   px/pz  – closest point on the centreline
 *   lat    – signed lateral offset (+ = right of travel direction)
 *   s      – lap-distance fraction 0..1 at the closest point
 */
export function trackLocate(track, x, z, hintIdx = null) {
  const pts = track.pts, n = pts.length;

  const scan = (from, to) => {
    let bi = -1, bd = Infinity;
    for (let k = from; k <= to; k++) {
      const i = ((k % n) + n) % n;
      const dx = x - pts[i].x, dz = z - pts[i].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    return { bi, bd };
  };

  let { bi, bd } = hintIdx == null ? scan(0, n - 1) : scan(hintIdx - 26, hintIdx + 26);
  // Hint window trapped in a bad local minimum? Do the full scan.
  if (hintIdx != null && bd > (track.halfWidth * 4) ** 2) ({ bi, bd } = scan(0, n - 1));

  // Project onto the segment before and after the best sample to get a
  // smooth closest point (samples are ~4 m apart).
  let best = null;
  for (const i0 of [(bi - 1 + n) % n, bi]) {
    const a = pts[i0], b = pts[(i0 + 1) % n];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz || 1e-6;
    const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
    const px = a.x + abx * t, pz = a.z + abz * t;
    const dx = x - px, dz = z - pz;
    const d2 = dx * dx + dz * dz;
    if (!best || d2 < best.d2) best = { i0, t, px, pz, d2 };
  }

  const a = pts[best.i0];
  const rx = a.dirZ, rz = -a.dirX; // right-hand normal
  const lat = (x - best.px) * rx + (z - best.pz) * rz;
  const d = a.d + a.segLen * best.t;
  return {
    idx: bi,
    px: best.px, pz: best.pz,
    dirX: a.dirX, dirZ: a.dirZ,
    lat,
    s: (d / track.total) % 1,
    dist: Math.sqrt(best.d2),
  };
}

/**
 * All situational physics modifiers at a car's position: track-wide
 * base grip, slick hazard zones, and the off-road penalty (mud, ash,
 * deep snow) for leaving the paved ribbon inside shortcut zones.
 * The server simulation and the client's prediction both call this,
 * so it must stay deterministic.
 */
export function terrainModsAt(track, st) {
  let grip = track.baseGrip * surfaceGripAt(track, st.x, st.z);
  let accelMul = 1, maxMul = 1;
  if (track.offRoad) {
    const loc = trackLocate(track, st.x, st.z, st.trackIdx);
    if (Math.abs(loc.lat) > track.halfWidth + 0.2) {
      grip *= track.offRoad.grip;
      accelMul = track.offRoad.accelMul;
      maxMul = track.offRoad.maxMul;
    }
  }
  // Floor the combined grip so stacked ice modifiers never reach
  // comedy-zero lateral control.
  return { grip: Math.max(grip, 0.12), accelMul, maxMul };
}

/**
 * Surface grip multiplier at a world position (slick hazard zones).
 * Track-wide base grip is handled separately via track.baseGrip.
 */
export function surfaceGripAt(track, x, z) {
  let grip = 1;
  for (const h of track.hazards) {
    if (h.type !== 'slick') continue;
    const dx = x - h.x, dz = z - h.z;
    if (dx * dx + dz * dz < h.r * h.r) grip = Math.min(grip, h.grip);
  }
  return grip;
}

/**
 * Keep a car inside the road unless it is inside an open (shortcut)
 * zone. Mutates state in place; returns the trackLocate result so the
 * caller can reuse it for progress/checkpoint logic.
 *
 * Pass `dt` (seconds) to enable the wall-recovery assist: while a car
 * is pressed against the wall, its heading is gently rotated toward
 * the nearest along-wall direction so it slides off instead of
 * grinding nose-first at a crawl. Both the server and the client's
 * prediction pass dt, so the assist stays deterministic.
 */
export function collideWithTrack(track, st, dt = 0) {
  const loc = trackLocate(track, st.x, st.z, st.trackIdx);
  st.trackIdx = loc.idx;
  st.wallHit = false;

  if (inOpenZone(track, st.x, st.z)) return loc;

  const maxLat = track.halfWidth - PHYS.CAR_RADIUS * 0.55;
  if (Math.abs(loc.lat) > maxLat) {
    const sign = Math.sign(loc.lat);
    const rx = loc.dirZ, rz = -loc.dirX;
    // Snap back to the wall line...
    st.x = loc.px + rx * sign * maxLat;
    st.z = loc.pz + rz * sign * maxLat;
    // ...and reflect away the outward velocity component (with a
    // little extra so cars visibly bounce off walls).
    const vOut = st.vx * rx * sign + st.vz * rz * sign;
    if (vOut > 0) {
      // Gentle bounce (1.2x removal) — harsh ricochets made the cars
      // feel uncontrollable at speed.
      st.vx -= vOut * rx * sign * 1.2;
      st.vz -= vOut * rz * sign * 1.2;
      if (vOut > 6) st.wallHit = true; // strong hit -> sfx cue
    }
    // Wall-recovery assist: steer toward whichever along-wall
    // direction (forward or backward along the road) is closer.
    if (dt > 0) {
      const fwdH = Math.atan2(loc.dirX, loc.dirZ);
      const bwdH = Math.atan2(-loc.dirX, -loc.dirZ);
      const dF = Math.abs(wrapAngle(fwdH - st.h));
      const dB = Math.abs(wrapAngle(bwdH - st.h));
      const diff = wrapAngle((dF <= dB ? fwdH : bwdH) - st.h);
      const step = Math.sign(diff) * Math.min(Math.abs(diff), 2.2 * dt);
      st.h = wrapAngle(st.h + step);
    }
  }
  return loc;
}

/**
 * Did lap-fraction motion a -> b cross checkpoint fraction c going
 * forward? Only counts if total forward motion is < half a lap, which
 * rules out "crossings" caused by driving backwards over the line.
 */
export function crossedForward(a, b, c) {
  const fwd = (x) => ((x % 1) + 1) % 1;
  const d2 = fwd(b - a);
  if (d2 <= 0 || d2 > 0.5) return false;
  const d1 = fwd(c - a);
  return d1 > 0 && d1 <= d2;
}
