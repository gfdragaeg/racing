/**
 * public/js/ui/hud.js
 * ------------------------------------------------------------------
 * In-race HUD: position, lap, health, boost, ability, speed, mini
 * leaderboard, centre messages and countdown. Pure DOM manipulation —
 * cheap enough to run every frame for the bars, while text fields are
 * only touched when their value changes.
 */

import { ABILITIES } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      pos: $('hud-pos'), lap: $('hud-lap'),
      hpFill: $('hud-hp-fill'), boostFill: $('hud-boost-fill'),
      ability: $('hud-ability'), speed: $('hud-speed'),
      board: $('hud-board'), center: $('hud-center'),
      status: $('hud-status'), hint: $('hud-hint'),
      glitch: $('hud-glitch'), slime: $('hud-slime'),
    };
    this.centerTimer = null;
    this.glitchTimer = null;
    this.cache = {};
  }

  reset() {
    this.el.center.textContent = '';
    this.el.status.textContent = '';
    this.el.hint.classList.remove('faded');
    this.el.glitch.classList.remove('on');
    this.el.slime.classList.remove('on');
    this.cache = {};
    // Fade the controls hint after a while.
    setTimeout(() => this.el.hint.classList.add('faded'), 12000);
  }

  /** Toggle the full-screen slime splatter (Slime Bomb COVER phase). */
  setSlime(on) {
    if (this._slimeOn === on) return; // avoid thrashing the class list
    this._slimeOn = on;
    this.el.slime.classList.toggle('on', on);
  }

  /**
   * Briefly flash the full-screen glitch overlay (GPS Jammer). The
   * warning text lives in the markup; here we just toggle it on for a
   * short, self-clearing burst.
   */
  glitch(text = 'SIGNAL JAMMED') {
    const warn = this.el.glitch.querySelector('.glitch-warn');
    if (warn) { warn.textContent = text; warn.dataset.text = text; }
    this.el.glitch.classList.add('on');
    clearTimeout(this.glitchTimer);
    this.glitchTimer = setTimeout(() => this.el.glitch.classList.remove('on'), 1300);
  }

  /** Big centre text; auto-clears unless sticky. */
  announce(text, ms = 1800) {
    this.el.center.textContent = text;
    clearTimeout(this.centerTimer);
    if (ms) this.centerTimer = setTimeout(() => { this.el.center.textContent = ''; }, ms);
  }

  /** Ordinal like 1st / 2nd / 3rd. */
  static ord(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /**
   * Per-frame update.
   * data = { pos, count, lap, totalLaps, hp, maxHp, boost, ability,
   *          speed, standings:[{name,lap,me,fin}], status }
   */
  update(d) {
    const c = this.cache;

    if (c.pos !== d.pos && d.pos) {
      c.pos = d.pos;
      this.el.pos.textContent = Hud.ord(d.pos);
    }
    const lapText = `LAP ${Math.min(d.lap + 1, d.totalLaps)}/${d.totalLaps}`;
    if (c.lap !== lapText) {
      c.lap = lapText;
      this.el.lap.textContent = lapText;
    }

    this.el.hpFill.style.width = `${Math.max(0, (d.hp / d.maxHp) * 100)}%`;
    this.el.hpFill.classList.toggle('low', d.hp / d.maxHp < 0.3);
    this.el.boostFill.style.width = `${d.boost}%`;

    if (c.ability !== d.ability) {
      c.ability = d.ability;
      const ab = d.ability ? ABILITIES[d.ability] : null;
      this.el.ability.textContent = ab ? ab.icon : '·';
      this.el.ability.title = ab ? `${ab.name} — press F` : 'Grab a crate!';
      this.el.ability.classList.toggle('has', !!ab);
    }

    // Display multiplier keeps the speedo reading "fast" after the
    // real-speed rebalance (27 m/s top speed reads ~116 km/h).
    const kmh = Math.round(d.speed * 4.3);
    if (c.kmh !== kmh) {
      c.kmh = kmh;
      this.el.speed.textContent = kmh;
    }

    // Mini leaderboard (top 8 is the whole field anyway).
    const boardKey = d.standings.map((s) => `${s.name}${s.lap}${s.me}${s.fin}`).join('|');
    if (c.board !== boardKey) {
      c.board = boardKey;
      this.el.board.innerHTML = d.standings.map((s, i) =>
        `<li class="${s.me ? 'me' : ''}">${i + 1}. ${escapeHtml(s.name)} ` +
        `<span class="lapn">${s.fin ? '🏁' : `L${Math.min(s.lap + 1, d.totalLaps)}`}</span></li>`,
      ).join('');
    }

    if (c.status !== d.status) {
      c.status = d.status;
      this.el.status.textContent = d.status;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
