/**
 * audio.js — Zero-dependency Web Audio API procedural horror sound engine
 * Produces dynamic Terror Radius heartbeat (70-180 BPM), werewolf howls,
 * claw slashes, skill check chimes, explosions, pallet stuns, and gothic bells.
 */

class HorrorAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.muted = false;
    this.lastBeatTime = 0;
    this.noiseBuffer = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.45;
      this.masterGain.connect(this.ctx.destination);
      this._buildNoiseBuffer();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setMuted(mute) {
    this.muted = !!mute;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.45, this.ctx.currentTime, 0.03);
    }
  }

  _buildNoiseBuffer() {
    const sr = this.ctx.sampleRate;
    const len = sr * 1.5;
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;
  }

  _ready() {
    if (this.muted) return false;
    if (!this.ctx) return false;
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx.state === "running";
  }

  /**
   * Called every frame when playing as a Villager.
   * Triggers a realistic two-thump lub-dub heartbeat scaling from 70 BPM (at maxRadius) to 180 BPM (close).
   */
  updateHeartbeat(distance, maxRadius = 560) {
    if (!this._ready()) return 0;
    if (distance > maxRadius) return 0;

    const intensity = Math.max(0, Math.min(1, 1 - distance / maxRadius));
    // Interval from 850ms (70 BPM) down to 330ms (180 BPM)
    const intervalSec = 0.85 - intensity * 0.52;
    const now = this.ctx.currentTime;

    if (now - this.lastBeatTime >= intervalSec) {
      this.lastBeatTime = now;
      const vol = 0.12 + intensity * 0.48;
      this._thump(now, 58 + intensity * 14, vol);
      this._thump(now + 0.13 - intensity * 0.04, 48 + intensity * 10, vol * 0.72);
    }
    return intensity;
  }

  _thump(startTime, freq, volume) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * 1.45, startTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, freq * 0.55), startTime + 0.13);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(startTime);
    osc.stop(startTime + 0.16);
  }

  playHowl() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc1.type = "sawtooth";
    osc2.type = "triangle";

    osc1.frequency.setValueAtTime(160, now);
    osc1.frequency.exponentialRampToValueAtTime(420, now + 0.35);
    osc1.frequency.linearRampToValueAtTime(360, now + 0.9);
    osc1.frequency.exponentialRampToValueAtTime(135, now + 1.65);

    osc2.frequency.setValueAtTime(162, now);
    osc2.frequency.exponentialRampToValueAtTime(424, now + 0.35);
    osc2.frequency.exponentialRampToValueAtTime(132, now + 1.65);

    filter.type = "bandpass";
    filter.frequency.setValueAtTime(520, now);
    filter.Q.setValueAtTime(2.6, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.32, now + 0.25);
    gain.gain.linearRampToValueAtTime(0.24, now + 1.0);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.7);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.72);
    osc2.stop(now + 1.72);
  }

  playSlash() {
    if (!this._ready() || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2200, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 0.18);
    filter.Q.setValueAtTime(1.8, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.38, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.22);
  }

  playHit() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    this.playSlash();
    this._thump(now, 110, 0.55);

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(280, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.25);
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  playSkillCheckWarn() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(780, now);
    osc.frequency.setValueAtTime(1040, now + 0.08);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.26, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  playSkillCheckSuccess(isGreat = false) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const freqs = isGreat ? [880, 1320] : [660, 880];
    freqs.forEach((f, idx) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f, now + idx * 0.06);
      g.gain.setValueAtTime(0.22, now + idx * 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.22);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now + idx * 0.06);
      osc.stop(now + idx * 0.06 + 0.24);
    });
  }

  playGeneratorExplosion() {
    if (!this._ready() || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    this._thump(now, 68, 0.72);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 0.55);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.55, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.62);
  }

  playPalletDrop() {
    if (!this._ready() || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    this._thump(now, 95, 0.55);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(620, now);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.38, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(f);
    f.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.18);
  }

  playStun() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    this.playPalletDrop();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(210, now + 0.05);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.55);
    g.gain.setValueAtTime(0.32, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.58);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now + 0.05);
    osc.stop(now + 0.6);
  }

  playTotemComplete() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [220, 330, 440, 660].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = i % 2 === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(0.18 / (i + 1), now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 1.45);
    });
  }

  playExitPowered() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [146.8, 220, 293.6, 440].forEach((freq) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sawtooth";
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now);
      osc.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.12, now + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, now + 2.1);
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 2.15);
    });
  }

  playCageLock() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    this._thump(now, 82, 0.48);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(480, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.18);
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  playFlashlight() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1450, now);
    osc.frequency.exponentialRampToValueAtTime(620, now + 0.22);
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.26);
  }
}

window.HorrorAudio = HorrorAudio;
