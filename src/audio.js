// A small generative techno set, synthesised live with WebAudio (no audio
// files). It also acts as the showroom's clock: lights, LED wall and lasers
// read the beat/section from here, so visuals stay in sync even when muted.

const BPM = 126;
const SPB = 60 / BPM; // seconds per beat
const STEP = SPB / 4; // 16th note
const BARS = 32; // arrangement cycle

// section map for the 32-bar cycle
function sectionOf(bar) {
  const b = bar % BARS;
  if (b < 8) return 'groove';
  if (b < 16) return 'build';
  if (b < 20) return 'break';
  return 'drop';
}

export class RaveAudio {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.startPerf = performance.now() / 1000;
    this.kicks = [];
    this.snares = [];
    this.distance = 1;
  }

  // ---------------------------------------------------------------- clock
  now() {
    if (this.ctx && this.playing) return this.ctx.currentTime - this.t0;
    return performance.now() / 1000 - this.startPerf;
  }
  info() {
    const t = this.now();
    const beatF = t / SPB;
    const beat = Math.floor(beatF);
    const bar = Math.floor(beat / 4);
    const section = sectionOf(bar);
    const phase = beatF - beat;
    const kickOn = section !== 'break';
    // envelope of the kick (1 on the beat, decays fast)
    const kick = kickOn ? Math.exp(-phase * 7) : 0;
    const sinceSnare = (((beatF - 1) % 2) + 2) % 2; // claps on beats 2 and 4
    const snare = section === 'build' || section === 'drop' ? Math.exp(-sinceSnare * 9) : 0;
    const barInCycle = bar % BARS;
    const buildUp = section === 'break' ? (barInCycle - 16 + phase / 4 + (beat % 4) / 4) / 4 : 0;
    return { t, beat, bar, phase, section, kick, snare, buildUp, bpm: BPM, energy: section === 'drop' ? 1 : section === 'build' ? 0.75 : section === 'break' ? 0.35 : 0.6 };
  }

  // ---------------------------------------------------------------- audio graph
  async start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.0;
      this.muffle = ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 18000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.15;
      this.master.connect(this.muffle).connect(comp).connect(ctx.destination);
      // reverb send for stabs/pads (generated impulse)
      this.verb = ctx.createConvolver();
      this.verb.buffer = this._impulse(2.8);
      this.verbSend = ctx.createGain();
      this.verbSend.gain.value = 0.35;
      this.verbSend.connect(this.verb).connect(this.master);
      this.noise = this._noiseBuffer();
      // keep visual clock continuous when audio starts
      this.t0 = ctx.currentTime - this.now();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.t0 = this.ctx.currentTime - (performance.now() / 1000 - this.startPerf);
    this.playing = true;
    this.nextStep = Math.ceil(this.now() / STEP);
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(0.8, this.ctx.currentTime, 0.3);
    clearInterval(this.timer);
    this.timer = setInterval(() => this._schedule(), 25);
    return true;
  }

  stop() {
    if (!this.ctx) return;
    // keep the visual clock continuous
    this.startPerf = performance.now() / 1000 - this.now();
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    this.playing = false;
    clearInterval(this.timer);
  }

  /** muffle the music with distance from the booth, like walking away from a club room */
  setListener(distance) {
    if (!this.ctx) return;
    this.distance = distance;
    const f = 18000 * Math.pow(0.82, Math.max(0, distance - 3)) + 450;
    this.muffle.frequency.setTargetAtTime(Math.min(18000, f), this.ctx.currentTime, 0.2);
    const g = this.playing ? Math.max(0.35, Math.min(0.85, 1.25 - distance * 0.06)) : 0;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.25);
  }

  _schedule() {
    const ctx = this.ctx;
    const ahead = 0.12;
    while (this.nextStep * STEP < this.now() + ahead) {
      const s = this.nextStep;
      const when = this.t0 + s * STEP;
      if (when >= ctx.currentTime - 0.01) this._playStep(s, when);
      this.nextStep++;
    }
  }

  _playStep(s, when) {
    const stepInBar = s % 16;
    const bar = Math.floor(s / 16);
    const sec = sectionOf(bar);
    const barInCycle = bar % BARS;
    const beatStep = stepInBar % 4;
    if (sec !== 'break') {
      if (beatStep === 0) this._kick(when);
      // rolling bass on the three 16ths after each kick
      if (beatStep !== 0) this._bass(when, bar, stepInBar, sec);
      if (beatStep === 2) this._hat(when, 0.16, sec === 'groove' ? 0.25 : 0.32); // open hat offbeat
      if (sec !== 'groove' || barInCycle >= 4) this._hat(when, 0.03, beatStep === 2 ? 0 : 0.09);
      if ((sec === 'build' || sec === 'drop') && (stepInBar === 4 || stepInBar === 12)) this._clap(when);
    }
    // stabs: syncopated chord hits
    const stabSteps = [3, 6, 10, 14];
    if ((sec === 'drop' || sec === 'build') && stabSteps.includes(stepInBar) && (sec === 'drop' || bar % 2 === 1))
      this._stab(when, bar);
    if (sec === 'break') {
      if (stepInBar === 0 && barInCycle % 2 === 0) this._pad(when, bar);
      // riser in the last two bars of the break
      if (barInCycle === 18 && stepInBar === 0) this._riser(when, SPB * 8);
      if (barInCycle >= 18 && stepInBar % 2 === 0) this._clap(when, 0.25 + (stepInBar / 16) * 0.5);
    }
  }

  _out(gain = 1) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  _kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.0, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(this._out(0.95));
    o.start(t);
    o.stop(t + 0.5);
    // click
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    n.connect(hp).connect(ng).connect(this._out(1));
    n.start(t);
    n.stop(t + 0.03);
  }

  _hat(t, len, vol) {
    if (vol <= 0) return;
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.playbackRate.value = 1 + Math.random() * 0.05;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const bp = ctx.createBiquadFilter();
    bp.type = 'peaking';
    bp.frequency.value = 10000;
    bp.gain.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(hp).connect(bp).connect(g).connect(this._out(1));
    n.start(t, Math.random());
    n.stop(t + len + 0.02);
  }

  _clap(t, vol = 0.45) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      g.gain.setValueAtTime(vol, t + i * 0.011);
      g.gain.exponentialRampToValueAtTime(0.05, t + i * 0.011 + 0.009);
    }
    g.gain.setValueAtTime(vol * 0.8, t + 0.034);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp).connect(g);
    g.connect(this._out(0.9));
    g.connect(this.verbSend);
    n.start(t, Math.random());
    n.stop(t + 0.3);
  }

  _bass(t, bar, stepInBar, sec) {
    const ctx = this.ctx;
    const roots = [45, 45, 43, 48]; // A, A, G, C (midi-ish below)
    const root = roots[Math.floor(bar / 2) % roots.length] - 12;
    const freq = 440 * Math.pow(2, (root - 69) / 12) * (stepInBar % 4 === 3 && stepInBar === 15 ? 2 : 1);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = freq * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    const open = sec === 'drop' ? 900 : sec === 'build' ? 600 + ((bar % 8) / 8) * 500 : 420;
    f.frequency.setValueAtTime(open * 2.2, t);
    f.frequency.exponentialRampToValueAtTime(open * 0.35, t + STEP * 0.9);
    f.Q.value = 7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 0.95);
    o.connect(f);
    o2.connect(f);
    f.connect(g).connect(this._out(0.75));
    o.start(t);
    o2.start(t);
    o.stop(t + STEP);
    o2.stop(t + STEP);
  }

  _stab(t, bar) {
    const ctx = this.ctx;
    const chords = [
      [57, 60, 64, 67],
      [57, 60, 64, 67],
      [55, 59, 62, 66],
      [60, 64, 67, 71],
    ];
    const ch = chords[Math.floor(bar / 2) % chords.length];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.09, t + 0.005);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3800, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    f.Q.value = 3;
    for (const m of ch) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + 0.32);
      }
    }
    f.connect(out);
    out.connect(this._out(1));
    out.connect(this.verbSend);
  }

  _pad(t, bar) {
    const ctx = this.ctx;
    const ch = bar % 4 < 2 ? [57, 64, 67, 72] : [55, 62, 66, 71];
    const len = SPB * 8;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.05, t + 1.2);
    out.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2500, t + len * 0.6);
    for (const m of ch) {
      for (const det of [-9, 0, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + len);
      }
    }
    f.connect(out);
    out.connect(this.verbSend);
    out.connect(this._out(0.6));
  }

  _riser(t, len) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + len);
    g.gain.setValueAtTime(0.0001, t + len + 0.01);
    n.connect(f).connect(g).connect(this._out(1));
    g.connect(this.verbSend);
    n.start(t);
    n.stop(t + len + 0.05);
  }

  _noiseBuffer() {
    const len = this.ctx.sampleRate * 2;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const b = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return b;
  }
}
