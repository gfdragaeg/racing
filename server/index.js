/**
 * server/index.js
 * ------------------------------------------------------------------
 * Chaos Circuit server entry point.
 *
 *  - Express serves the static client (public/), the shared game
 *    modules (shared/) and the Three.js library from node_modules.
 *  - Socket.IO carries all realtime traffic; every socket is handed
 *    to the LobbyManager which owns rooms and race instances.
 *
 * Deployment: `node server/index.js` (respects process.env.PORT), so
 * it drops straight onto Render / Railway / Fly / a bare VPS.
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { LobbyManager } from './lobby/LobbyManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  // Same-origin by default. Loosen CORS here if the client is ever
  // hosted separately from the game server.
});

// Shared simulation code is imported by the browser as ES modules.
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// Serve Three.js from node_modules so the client has zero CDN deps.
app.get('/vendor/three.module.js', (_req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js')));
// The client itself.
app.use(express.static(path.join(ROOT, 'public')));

// Simple health endpoint for hosting platforms.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const lobby = new LobbyManager(io);
io.on('connection', (socket) => lobby.handleConnection(socket));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[chaos-circuit] listening on http://localhost:${PORT}`);
});
