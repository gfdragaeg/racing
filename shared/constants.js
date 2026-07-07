/**
 * shared/constants.js
 * ------------------------------------------------------------------
 * Game-wide tuning constants shared VERBATIM between the Node server
 * and the browser client. Because both sides run the same vehicle
 * simulation (server = authority, client = prediction), every number
 * that affects movement MUST live here so the two simulations agree.
 */

/** Server simulation rate (fixed timestep, Hz). */
export const TICK_RATE = 30;
/** How often the server broadcasts world snapshots (Hz). */
export const SNAP_RATE = 15;
/** Milliseconds of pre-race countdown after every client has loaded. */
export const COUNTDOWN_MS = 3000;
/** Maximum racers in a room (humans + bots combined). */
export const MAX_PLAYERS = 8;
/** Seconds a destroyed car waits before respawning. */
export const RESPAWN_SECONDS = 3;
/** Seconds of spawn protection after a respawn. */
export const INVULN_SECONDS = 2;
/** Race hard-ends this many seconds after the first human finishes. */
export const FINISH_GRACE_SECONDS = 45;

/**
 * Arcade vehicle physics tuning. Deliberately simple: a single rigid
 * "puck" with forward/lateral velocity decomposition. No suspension,
 * no wheels, no realistic tire model — per the design brief.
 */
export const PHYS = {
  ENGINE_ACCEL: 22,        // m/s^2 at full throttle
  BRAKE_DECEL: 42,         // m/s^2 while braking from forward motion
  REVERSE_MAX: 10,         // max reverse speed, m/s
  MAX_SPEED: 27,           // max forward speed (before boost), m/s
  DRAG: 0.42,              // linear drag coefficient (per second)
  STEER_RATE: 2.4,         // base yaw rate, rad/s
  STEER_SPEED_FALLOFF: 46, // higher = less steering loss at speed
  GRIP: 9.0,               // lateral velocity damping (per second)
  DRIFT_GRIP: 3.4,         // grip while drifting (slides, but not wildly)
  GRAVITY: 26,             // m/s^2 (arcadey, heavier than earth)
  JUMP_VY: 8,              // vertical launch speed for the hop/jump
  CAR_RADIUS: 1.6,         // collision circle radius, m
  BOOST_ACCEL_MUL: 1.9,    // engine accel multiplier while boosting
  BOOST_MAXSPEED_MUL: 1.28,// top speed multiplier while boosting
  BOOST_METER_MAX: 100,    // drift-earned boost meter capacity
  DRIFT_FILL_RATE: 30,     // meter gained per second of drifting
  BOOST_DRAIN_RATE: 45,    // meter spent per second while boosting
  SPIN_RATE: 9.5,          // yaw rate while spun out by oil, rad/s
};

/**
 * Ability catalogue. `damage` values follow the design brief and are
 * meant to be balanced later. Icons are plain emoji so the HUD needs
 * zero art assets. Server logic for each id lives in
 * server/game/Abilities.js; client VFX in public/js/game/Effects.js.
 */
export const ABILITIES = {
  rocket:  { name: 'Rocket',          icon: '🚀', damage: 30 },
  emp:     { name: 'EMP Blast',       icon: '⚡', damage: 0  },
  oil:     { name: 'Oil Slick',       icon: '🛢️', damage: 0  },
  fire:    { name: 'Fire Trail',      icon: '🔥', damage: 5  }, // per second
  mine:    { name: 'Freeze Mine',     icon: '❄️', damage: 0  },
  shock:   { name: 'Shockwave',       icon: '💥', damage: 15 },
  rail:    { name: 'Railgun',         icon: '🎯', damage: 40 },
  cluster: { name: 'Cluster Bomb',    icon: '💣', damage: 12 }, // per bomblet
  chain:   { name: 'Chain Lightning', icon: '🌩️', damage: 20 },
  shield:  { name: 'Shield',          icon: '🛡️', damage: 0  },
  nitro:   { name: 'Nitro Burst',     icon: '🚄', damage: 0  },
  minigun: { name: 'Minigun',         icon: '🔫', damage: 4  }, // per bullet
  bouncer: { name: 'Bouncer',         icon: '🔮', damage: 25 },
  jammer:  { name: 'GPS Jammer',      icon: '🛰️', damage: 0  },
  slime:   { name: 'Slime Bomb',      icon: '🟢', damage: 0  },
};
export const ABILITY_IDS = Object.keys(ABILITIES);

/**
 * Relative spawn weights for the random crate roll. Anything omitted is
 * weight 1. Powerful or swingy items are rarer; the GPS Jammer is a
 * rare catch-up item (~2% of crates).
 */
export const ABILITY_WEIGHTS = {
  jammer: 0.3,
  slime: 0.5,
  rail: 0.7,
  cluster: 0.8,
  bouncer: 0.8,
  chain: 0.8,
  shield: 0.85,
  nitro: 0.9,
};

/** Top-speed multiplier applied while a car is GPS-jammed. */
export const JAM_SPEED_MUL = 0.8;   // −20% top speed
/** Duration of the GPS jam, seconds. */
export const JAM_SECONDS = 5;

/**
 * Slime Bomb timing. A hit splatters the victim's screen with slime
 * (hard to see) for SLIME_COVER_SECONDS, then the slime drips off and
 * they're slowed for SLIME_SLOW_SECONDS. Modelled as one countdown
 * timer `fxSlime` = COVER + SLOW: while it's above SLOW_SECONDS the
 * screen is covered; at or below it, they're slowed.
 */
export const SLIME_COVER_SECONDS = 5;
export const SLIME_SLOW_SECONDS = 5;
export const SLIME_TOTAL_SECONDS = SLIME_COVER_SECONDS + SLIME_SLOW_SECONDS;
export const SLIME_SPEED_MUL = 0.65;  // −35% top speed during the slow phase

/** Crate respawn delay in seconds, per host "Ability Spawn Rate" setting. */
export const PICKUP_RATES = { low: 12, normal: 7, high: 4, chaos: 2 };

/** Lobby settings the host may choose from (validated server-side). */
export const SETTING_OPTIONS = {
  mode:   ['classic', 'combat'],
  map:    ['downtown', 'volcano', 'frozen', 'toxic'],
  laps:   [2, 3, 5],
  health: [50, 100, 200],
  rate:   ['low', 'normal', 'high', 'chaos'],
  bots:   [0, 1, 2, 3, 4, 5, 6, 7],
};

/** Default lobby settings for a freshly created room. */
export const DEFAULT_SETTINGS = {
  mode: 'combat',
  map: 'downtown',
  laps: 3,
  health: 100,
  rate: 'normal',
  bots: 0,
  private: false,
};

/**
 * Named car-colour palette players can pick from in the lobby. The
 * server validates chosen colours against these hex values, so the
 * client can only ever select a legal colour.
 */
export const CAR_COLORS = [
  { id: 'red',      name: 'Red',       hex: '#ff4d4d' },
  { id: 'babyblue', name: 'Baby Blue', hex: '#7ec8ff' },
  { id: 'green',    name: 'Green',     hex: '#5bde6b' },
  { id: 'yellow',   name: 'Yellow',    hex: '#ffd24d' },
  { id: 'purple',   name: 'Purple',    hex: '#c86bff' },
  { id: 'pink',     name: 'Pink',      hex: '#ff6bd5' },
  { id: 'golden',   name: 'Golden',    hex: '#ffb020' },
  { id: 'teal',     name: 'Teal',      hex: '#2ce0c8' },
];
/** Set of valid colour hex strings for server-side validation. */
export const CAR_COLOR_HEXES = CAR_COLORS.map((c) => c.hex);

/** Default car colours assigned by lobby slot (index 0..7). */
export const PLAYER_COLORS = CAR_COLORS.map((c) => c.hex);

/** Silly names for server-controlled bots. */
export const BOT_NAMES = [
  'TURBO-8', 'NITRA', 'KABOOM', 'VOLTZ', 'SKIDLY', 'FURY-2', 'ZOOMER', 'CRASHR',
];

/* ----------------------------- helpers ----------------------------- */

/** Clamp x into [lo, hi]. */
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Wrap an angle into (-PI, PI]. */
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Shortest-path interpolation between two angles. */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

/** Plain linear interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t;
