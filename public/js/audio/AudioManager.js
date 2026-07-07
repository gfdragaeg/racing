/**
 * public/js/audio/AudioManager.js
 * ------------------------------------------------------------------
 * Placeholder audio, 100% synthesized with WebAudio — no asset files.
 * Covers the design brief's list: engine, boost, explosion, ability,
 * countdown, crowd. Everything routes through a master gain so the
 * settings screen's sliders work uniformly.
 *
 * The AudioContext is created lazily on the first user gesture
 * (browser autoplay policy).
 */

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.engineGain = null;
    this.engineOsc = null;
    this.volumes = { master: 0.8, sfx: 0.8, engine: 0.5 };

    // Restore saved volumes.
    try {
      const saved = JSON.parse(localStorage.getItem('cc-volumes'));
      if (saved) Object.assign(this.volumes, saved);
    } catch { /* fresh browser */ }
  }

  /** Must be called from a click/keydown handler at least once. */
  unlock() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.applyVolumes();
  }

  setVolume(kind, v01) {
    this.volumes[kind] = v01;
    localStorage.setItem('cc-volumes', JSON.stringify(this.volumes));
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfxGain.gain.value = this.volumes.sfx;
    if (this.engineGain) this.engineBase = this.volumes.engine;
  }

  /* ---------------------------- engine ---------------------------- */

  /** Continuous engine loop; call stopEngine() when the race ends. */
  startEngine() {
    if (!this.ctx || this.engineOsc) return;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 55;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(filter).connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineBase = this.volumes.engine;
  }

  /** Pitch/volume tracks the car's speed and throttle every frame. */
  updateEngine(speed01, throttle01, boosting) {
    if (!this.engineOsc) return;
    const f = 50 + speed01 * 160 + (boosting ? 40 : 0);
    this.engineOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    const g = (0.04 + speed01 * 0.10 + throttle01 * 0.05) * (this.engineBase ?? 0.5);
    this.engineGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08);
  }

  stopEngine() {
    if (!this.engineOsc) return;
    try { this.engineOsc.stop(); } catch { /* already stopped */ }
    this.engineOsc = null;
    this.engineGain = null;
  }

  /* --------------------------- one-shots -------------------------- */

  /**
   * Play a named effect. `dist` (metres from our car) attenuates
   * far-away events so the battlefield feels spatial.
   */
  play(name, dist = 0) {
    if (!this.ctx) return;
    const atten = Math.max(0.05, 1 - dist / 90);
    switch (name) {
      case 'boom': this.noiseBurst(0.6, 300, 0.9 * atten); break;
      case 'boomBig': this.noiseBurst(1.1, 200, 1.2 * atten); break;
      case 'rail': this.zap(900, 120, 0.25, 0.5 * atten); break;
      case 'gun': this.zap(1500, 500, 0.05, 0.2 * atten); break;
      case 'jam': // descending electronic scramble
        this.sweep(1200, 110, 0.6, 0.4);
        this.zap(500, 60, 0.55, 0.3);
        this.noiseBurst(0.5, 1200, 0.25);
        break;
      case 'chain': this.zap(1400, 300, 0.3, 0.4 * atten); break;
      case 'emp': this.zap(300, 40, 0.5, 0.5 * atten); break;
      case 'shock': this.noiseBurst(0.35, 500, 0.6 * atten); break;
      case 'pickup': this.arp([660, 880, 1320], 0.06, 0.35); break;
      case 'use': this.arp([440, 550], 0.05, 0.3); break;
      case 'boost': this.sweep(200, 900, 0.4, 0.35); break;
      case 'pad': this.sweep(300, 1100, 0.25, 0.3 * atten); break;
      case 'freeze': this.arp([1800, 1400, 1000], 0.09, 0.3 * atten); break;
      case 'oil': this.sweep(500, 150, 0.3, 0.3 * atten); break;
      case 'hit': this.noiseBurst(0.12, 900, 0.35 * atten); break;
      case 'wall': this.noiseBurst(0.1, 700, 0.25); break;
      case 'lap': this.arp([523, 659, 784], 0.08, 0.4); break;
      case 'count': this.beep(440, 0.15, 0.5); break;
      case 'go': this.beep(880, 0.4, 0.6); break;
      case 'finish': this.arp([523, 659, 784, 1046], 0.12, 0.5); break;
      case 'shieldPop': this.beep(220, 0.2, 0.4 * atten); break;
      case 'crowd': this.crowd(); break;
    }
  }

  /* ------------------------- synth helpers ------------------------ */

  beep(freq, dur, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol * 0.5, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.sfxGain);
    o.start();
    o.stop(this.ctx.currentTime + dur);
  }

  /** Quick note sequence — pickups, laps, fanfares. */
  arp(freqs, step, vol) {
    freqs.forEach((f, i) => setTimeout(() => this.beep(f, step * 2, vol), i * step * 1000));
  }

  /** Filtered noise — explosions, impacts. */
  noiseBurst(dur, filterHz, vol) {
    const n = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterHz;
    const g = this.ctx.createGain();
    g.gain.value = vol * 0.6;
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start();
  }

  /** Pitch-sweeping tone — boosts, whooshes. */
  sweep(from, to, dur, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(from, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), this.ctx.currentTime + dur);
    g.gain.setValueAtTime(vol * 0.4, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.sfxGain);
    o.start();
    o.stop(this.ctx.currentTime + dur);
  }

  /** Electric zap — railgun / lightning / EMP. */
  zap(from, to, dur, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(from, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), this.ctx.currentTime + dur);
    g.gain.setValueAtTime(vol * 0.35, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.sfxGain);
    o.start();
    o.stop(this.ctx.currentTime + dur);
  }

  /** Low murmur "crowd" pad played at race start. */
  crowd() {
    const n = this.ctx.sampleRate * 2.5;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < n; i++) {
      v += (Math.random() * 2 - 1) * 0.02; v *= 0.995; // brownish noise
      d[i] = v * Math.sin((i / n) * Math.PI);          // fade in & out
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 500;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start();
  }
}

export const audio = new AudioManager();
