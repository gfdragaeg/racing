/**
 * public/js/game/Input.js
 * ------------------------------------------------------------------
 * Driving input capture — keyboard AND on-screen touch controls.
 *
 * Keyboard:
 *   W / ↑        throttle          S / ↓   brake & reverse
 *   A / ←        steer left        D / →   steer right
 *   SHIFT        hop; hold while steering to drift (fills boost meter)
 *   SPACE        spend boost meter
 *   C            hold to look behind (client-side camera only)
 *   F            fire held ability
 *   ESC          pause menu (handled by GameClient)
 *
 * Touch: the #touch-controls buttons (index.html) drive the same
 * signals via pointer events, so a phone player produces identical
 * input frames to a keyboard player. Buttons use setPointerCapture so
 * multi-touch (steer + gas at once) works and a finger sliding off a
 * button still releases it.
 *
 * jump/fire are EDGE-triggered: reported exactly once per press (the
 * server latches them until its next tick).
 */

/** Keys that mean "hop/drift" (SHIFT) — left or right modifier. */
const DRIFT_KEYS = ['ShiftLeft', 'ShiftRight'];

export class Input {
  constructor() {
    this.keys = new Set();
    this.jumpEdge = false;
    this.fireEdge = false;
    this.enabled = false;

    // Held state of the on-screen touch buttons.
    this.touch = {
      left: false, right: false, gas: false, brake: false,
      drift: false, boost: false, lookback: false,
    };

    this._down = (e) => {
      if (!this.enabled) return;
      const k = e.code;
      // Prevent the browser's default action for keys we drive with.
      if (k === 'Space' || DRIFT_KEYS.includes(k)) e.preventDefault();
      if (!this.keys.has(k)) {
        // Hop edge fires on the SHIFT press (drift/hop moved off SPACE).
        if (DRIFT_KEYS.includes(k)) this.jumpEdge = true;
        if (k === 'KeyF') this.fireEdge = true;
      }
      this.keys.add(k);
    };
    this._up = (e) => this.keys.delete(e.code);
    this._blur = () => { this.keys.clear(); this.clearTouch(); }; // don't drive blind on alt-tab

    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('blur', this._blur);

    this.bindTouchButtons();
  }

  /* ------------------------------------------------------------ *
   *  Touch controls
   * ------------------------------------------------------------ */

  /** Wire pointer events on every [data-touch] button in the DOM. */
  bindTouchButtons() {
    const buttons = document.querySelectorAll('[data-touch]');
    buttons.forEach((btn) => {
      const action = btn.dataset.touch;

      const press = (e) => {
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch { /* older browser */ }
        btn.classList.add('pressed');
        if (action === 'fire') {
          this.fireEdge = true;
        } else if (action === 'drift') {
          this.touch.drift = true;
          this.jumpEdge = true; // pressing DRIFT also hops, like SHIFT
        } else {
          this.touch[action] = true;
        }
      };
      const release = () => {
        btn.classList.remove('pressed');
        if (action === 'fire') return;          // edge-only, nothing held
        if (action === 'drift') this.touch.drift = false;
        else this.touch[action] = false;
      };

      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      // Belt-and-braces for browsers that don't capture cleanly.
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  /** Release every touch button (screen change / focus loss). */
  clearTouch() {
    for (const key of Object.keys(this.touch)) this.touch[key] = false;
    document.querySelectorAll('[data-touch].pressed')
      .forEach((b) => b.classList.remove('pressed'));
  }

  /* ------------------------------------------------------------ *
   *  Sampling
   * ------------------------------------------------------------ */

  /**
   * Read the current input frame. Edge flags reset after each call, so
   * call exactly once per simulation frame.
   */
  sample() {
    const k = this.keys;
    const t = this.touch;
    // Positive steer yaws the heading toward world +X, which the chase
    // camera shows on the LEFT of the screen. So LEFT produces +1.
    const th = clamp1(
      (k.has('KeyW') || k.has('ArrowUp') || t.gas ? 1 : 0) +
      (k.has('KeyS') || k.has('ArrowDown') || t.brake ? -1 : 0));
    const st = clamp1(
      (k.has('KeyA') || k.has('ArrowLeft') || t.left ? 1 : 0) +
      (k.has('KeyD') || k.has('ArrowRight') || t.right ? -1 : 0));
    const out = {
      th, st,
      drift: k.has('ShiftLeft') || k.has('ShiftRight') || t.drift,
      boost: k.has('Space') || t.boost,
      jump: this.jumpEdge,
      fire: this.fireEdge,
    };
    this.jumpEdge = false;
    this.fireEdge = false;
    return out;
  }

  /**
   * Look-behind is a purely client-side camera state, so it is read
   * separately and never sent over the network (the server does not
   * care which way the camera faces).
   */
  wantsLookBack() {
    return this.enabled && (this.keys.has('KeyC') || this.touch.lookback);
  }

  /** Zeroed input, used while paused/dead/spectating. */
  static idle() {
    return { th: 0, st: 0, drift: false, boost: false, jump: false, fire: false };
  }
}

/** Clamp to [-1, 1] (keyboard + touch could otherwise sum past 1). */
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
