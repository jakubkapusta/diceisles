// Procedural sound effects built with the Web Audio API. Nothing is loaded from files,
// so the single-file build stays self-contained.

const MASTER_VOLUME = 0.7;
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];

export class Sound {
  constructor() {
    this.enabled = true;
    this.oceanOn = true; // the 3D board shows a sea
    this.ambience = true; // the player wants background sound
    this.ctx = null;
    this.lastLand = 0;
  }

  // Browsers only allow audio after a user gesture, so this is called from input handlers.
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? MASTER_VOLUME : 0;
      const compressor = ctx.createDynamicsCompressor();
      this.master.connect(compressor).connect(ctx.destination);
      this.noiseBuffer = this.makeNoise();
      this.startOcean();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? MASTER_VOLUME : 0, this.ctx.currentTime, 0.05);
  }

  get ready() {
    return !!this.ctx && this.enabled && this.ctx.state === 'running';
  }

  // ---------- building blocks ----------

  makeNoise() {
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  envelope(t, attack, peak, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  // Short filtered noise burst: dice hitting each other or the table.
  click(t, freq, gain, decay) {
    const src = this.noise();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.8;
    const env = this.envelope(t, 0.002, gain, decay);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.05);
  }

  tone(t, freq, duration, { type = 'sine', gain = 0.15, attack = 0.005, glideTo = null } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration);
    const env = this.envelope(t, attack, gain, duration);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + attack + duration + 0.05);
  }

  // Bandpassed noise sweeping through frequencies: a whoosh.
  sweep(t, from, to, duration, gain) {
    const src = this.noise();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + duration);
    const env = this.envelope(t, duration * 0.4, gain, duration * 0.6);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + duration + 0.05);
  }

  // The surf ambience belongs to the 3D sea, so the 2D board turns it off.
  setOcean(on) {
    this.oceanOn = on;
    this.updateOcean();
  }

  // Player setting: sound effects only, without the background surf.
  setAmbience(on) {
    this.ambience = on;
    this.updateOcean();
  }

  updateOcean() {
    if (this.ocean) this.ocean.gain.setTargetAtTime(this.oceanOn && this.ambience ? 1 : 0, this.ctx.currentTime, 0.3);
  }

  // Gentle surf in the background: two noise layers breathing with slow LFOs.
  startOcean() {
    const ctx = this.ctx;
    this.ocean = ctx.createGain();
    this.ocean.gain.value = this.oceanOn && this.ambience ? 1 : 0;
    this.ocean.connect(this.master);
    const layer = (type, freq, base, depth, rate) => {
      const src = this.noise();
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = base;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = depth;
      lfo.connect(lfoGain).connect(gain.gain);
      src.connect(filter).connect(gain).connect(this.ocean);
      src.start();
      lfo.start();
    };
    layer('lowpass', 380, 0.035, 0.025, 0.11);
    layer('bandpass', 1100, 0.012, 0.01, 0.17);
  }

  // ---------- game sounds ----------

  // Dice rattling in a cup and settling: dense clicks at first, thinning out towards the end.
  roll(duration, diceCount) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime;
    const clicks = Math.round(10 + diceCount * 2 + duration * 16);
    for (let i = 0; i < clicks; i++) {
      const t = t0 + duration * Math.pow(Math.random(), 1.6);
      this.click(t, 1800 + Math.random() * 2800, 0.05 + Math.random() * 0.1, 0.02 + Math.random() * 0.03);
    }
    this.click(t0 + duration, 2600, 0.18, 0.05);
  }

  // One die landing on the board; throttled because many land at once.
  land() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t - this.lastLand < 0.035) return;
    this.lastLand = t;
    this.click(t, 2200 + Math.random() * 1200, 0.07, 0.03);
    this.tone(t, 170 + Math.random() * 40, 0.07, { gain: 0.05, glideTo: 90 });
  }

  select() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, 880, 0.07, { gain: 0.06 });
    this.tone(t + 0.03, 1320, 0.06, { gain: 0.03 });
  }

  // Successful attack: a whoosh and a bright rising two-note chime.
  win() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.sweep(t, 400, 2400, 0.3, 0.12);
    this.tone(t + 0.05, 523.25, 0.25, { type: 'triangle', gain: 0.14 });
    this.tone(t + 0.14, 783.99, 0.35, { type: 'triangle', gain: 0.14 });
    this.click(t + 0.14, 6000, 0.05, 0.08);
  }

  // Failed attack: a dull falling thud.
  lose() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, 220, 0.35, { type: 'triangle', gain: 0.16, glideTo: 130 });
    this.tone(t, 90, 0.25, { gain: 0.18, glideTo: 50 });
    this.click(t, 500, 0.12, 0.12);
  }

  // Reinforcements: a few soft plinks, more dice = more plinks (capped).
  reinforce(count, volume = 1) {
    if (!this.ready || count <= 0) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < Math.min(count, 8); i++) {
      const note = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
      this.tone(t + i * 0.06, note, 0.14, { gain: 0.06 * volume });
    }
  }

  // Start of the player's turn: a soft two-note bell.
  turn() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, 659.25, 0.6, { gain: 0.1 });
    this.tone(t, 1318.5, 0.4, { gain: 0.03 });
    this.tone(t + 0.12, 987.77, 0.8, { gain: 0.09 });
  }

  // Two short woofs: a sawtooth dropping in pitch through a formant-like bandpass, plus breath noise.
  bark() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime;
    for (const delay of [0, 0.28]) {
      const t = t0 + delay;
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(540, t);
      osc.frequency.exponentialRampToValueAtTime(250, t + 0.13);
      const formant = this.ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = 950;
      formant.Q.value = 1.3;
      const env = this.envelope(t, 0.008, 0.25, 0.14);
      osc.connect(formant).connect(env).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.2);
      this.click(t, 1600, 0.12, 0.07);
    }
  }

  victory() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(t + i * 0.13, f, i === 3 ? 1.2 : 0.3, { type: 'triangle', gain: 0.15 });
      this.tone(t + i * 0.13, f * 2, i === 3 ? 0.8 : 0.2, { gain: 0.04 });
    });
  }

  defeat() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [392, 349.23, 311.13, 261.63].forEach((f, i) => {
      this.tone(t + i * 0.22, f, i === 3 ? 1.2 : 0.35, { type: 'triangle', gain: 0.14 });
    });
  }
}
