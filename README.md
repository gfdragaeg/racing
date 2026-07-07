# Chaos Circuit 🏎️💥

A browser-based **multiplayer combat racing game**: 2–8 players race
around hazard-filled tracks while collecting offensive abilities to
blast each other with. Built with **Node.js + Socket.IO** (server
authoritative) and **Three.js** (client rendering).

## Quick start

```bash
npm install
npm start          # serves the game on http://localhost:3000
```

Open `http://localhost:3000`, pick a name, **Play → Create Room**,
share the 5-letter room code with friends on the same server, and
start the race. Solo? Add bots in the lobby (0–7).

Headless second player for testing:

```bash
node tools/testClient.js <ROOMCODE> [name]
```

## Controls

| Key | Action |
| --- | --- |
| `W / ↑`, `S / ↓` | throttle / brake & reverse |
| `A / ←`, `D / →` | steer |
| `SHIFT` | hop; hold while steering to **drift** (fills boost meter) |
| `SPACE` | spend boost meter |
| `C` | hold to look behind |
| `F` | fire held ability |
| `ESC` | pause menu (the race keeps running!) |

**Mobile / touch:** on phones and tablets, on-screen controls appear
automatically — steering and drift/boost under the left thumb, gas/brake
and fire under the right thumb, plus look-behind and pause buttons. The
info HUD moves to the top so the thumb zones stay clear. Play in
landscape for the roomiest layout. (Plug in a keyboard and the touch UI
steps aside on the first key press.)

## Features

- **Lobby system** — create/join via room code, ready-up, host controls
  (mode, map, laps, health, ability spawn rate, bot count, private flag),
  joining is blocked once a race starts.
- **Game modes** — Combat Race (abilities on) and Classic Race
  (pure racing, no pickups). Last Driver Standing & Time Trial are
  planned (see roadmap).
- **Four tracks** — Downtown Circuit (beginner: wide roads, tunnels,
  alley shortcuts, ramps), Volcano Run (hard: narrow, lava, falling
  rocks, collapsing bridge, and **bottomless pits — fall in and you
  restart the current lap**), Frozen Summit (low-grip ice, frozen-lake
  shortcut, moving glaciers, snowstorm), and Toxic Waste (radioactive
  sludge, toxic-waste pools and slippery ooze).
- **15 abilities** — Rocket (homing), EMP, Oil Slick, Fire Trail,
  Freeze Mine, Shockwave, Railgun, Cluster Bomb, Chain Lightning,
  Shield, Nitro, Minigun, Bouncer, GPS Jammer (locks onto 1st place),
  and Slime Bomb (splatters the target's screen for 5 s, then slows
  them for 5 s) — all simulated on the server.
- **Car customization** — pick your car colour in the lobby from eight
  colours (red, baby blue, green, yellow, purple, pink, golden, teal);
  click a swatch or click your own colour dot to cycle.
- **Health & respawns** — explode at 0 HP, respawn at your last
  checkpoint after 3 s with brief spawn protection. Nobody is ever
  eliminated.
- **Arcade driving** — acceleration, braking, reverse, drifting with a
  drift-earned boost meter, hops, boost pads and launch ramps.
- **Bots** — server-side AI racers to fill the grid (and autopilot for
  finished players' cars).
- **End-of-match screen** — finishing order, fastest lap, damage
  dealt/taken, abilities used, rematch and return-to-lobby.
- **Placeholder audio** — engine, boost, explosions, abilities,
  countdown and crowd are synthesized live with WebAudio (zero asset
  files).

## Architecture

```
shared/            code executed by BOTH server and browser
  constants.js       physics tuning, abilities, settings, helpers
  physics.js         stepVehicle(): the arcade car simulation
  tracks.js          track data + geometry queries (collision, laps)

server/
  index.js           Express + Socket.IO bootstrap, static serving
  lobby/LobbyManager.js   rooms, codes, ready flow, host migration
  game/Game.js            authoritative 30 Hz race simulation
  game/Abilities.js       all weapon/effect logic + damage handling
  game/Bots.js            bot driver AI

public/
  js/main.js         screen router + menu/lobby/results UI
  js/net.js          Socket.IO wrapper
  js/game/GameClient.js   prediction, reconciliation, interpolation
  js/game/Renderer.js     Three.js scene, cars, camera, weather
  js/game/TrackBuilder.js track geometry from shared track data
  js/game/Effects.js      transient combat VFX
  js/game/Input.js        keyboard capture
  js/ui/hud.js       in-race HUD
  js/audio/AudioManager.js  synthesized placeholder audio
  js/voice/VoiceChat.js     WebRTC proximity-voice stub (future)
```

**Networking model:** clients send only inputs (sequence-numbered, 30 Hz).
The server simulates everything at 30 Hz and broadcasts 15 Hz snapshots.
The local car is client-side predicted and reconciled against server
acks; remote cars interpolate ~120 ms in the past. All combat, laps,
pickups and hazards are server-side only — there is nothing a modified
client can cheat with beyond its own inputs.

**Voice chat readiness:** the server already relays `voice:signal`
messages between room members (WebRTC signalling), and the game loop
feeds positional data into the `VoiceChat` stub for future proximity
attenuation.

## Deployment

Any Node 18+ host works — the server binds `process.env.PORT`:

- **Render/Railway/Fly**: build `npm install`, start `npm start`.
- Static assets, shared modules and Three.js are all served by the
  same Express process; no CDN or build step required.
- WebSockets must be allowed (Socket.IO falls back to polling if not).

## Roadmap

- Last Driver Standing (limited respawns) & Time Trial modes
- Room browser for public lobbies (the `private` flag already exists)
- WebRTC proximity voice chat (signalling + stubs already in place)
- Real art & audio assets to replace placeholders
