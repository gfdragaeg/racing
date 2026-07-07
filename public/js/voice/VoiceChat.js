/**
 * public/js/voice/VoiceChat.js
 * ------------------------------------------------------------------
 * PROXIMITY VOICE CHAT — INTENTIONALLY NOT IMPLEMENTED YET.
 *
 * This stub exists so the first playable version already has the
 * architectural seams voice chat needs, per the design brief:
 *
 *  1. SIGNALLING — the server already relays opaque `voice:signal`
 *     payloads between members of the same room (see
 *     LobbyManager.handleConnection). That is all WebRTC needs to
 *     exchange SDP offers/answers and ICE candidates.
 *
 *  2. PROXIMITY DATA — GameClient knows every car's world position
 *     each frame and calls setListenerPose()/setPeerPose() below, so
 *     distance-based volume is a pure client-side concern.
 *
 * Implementation plan (future):
 *  - getUserMedia() for the mic, one RTCPeerConnection per room peer
 *    (max 7 — a full mesh is fine at this scale).
 *  - Route each remote MediaStream through WebAudio PannerNodes and
 *    feed them the poses already arriving here.
 *  - Push-to-talk key in Input.js; mute toggles in the pause menu.
 */

export class VoiceChat {
  constructor(net) {
    this.net = net;
    this.enabled = false; // flipped on when the feature ships
    // Reserved: net.on('voice:signal', (msg) => this.onSignal(msg));
  }

  /** Join the voice mesh for a room. No-op until implemented. */
  join(_roomCode, _peerIds) {}

  /** Leave the mesh and release the mic. No-op until implemented. */
  leave() {}

  /** Called every frame with our own car's position/heading. */
  setListenerPose(_x, _z, _heading) {}

  /** Called every frame per remote player for proximity attenuation. */
  setPeerPose(_peerId, _x, _z) {}
}
