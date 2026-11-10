// A quiet, bell-like ringtone made with WebAudio.
// Browsers only let audio start after the user has interacted with the page,
// so the context is unlocked on the first tap and reused when the alarm fires.

export class Ringer {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.oscillators = new Set();
  }

  get unlocked() {
    return this.ctx?.state === 'running';
  }

  unlock() {
    try {
      if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      /* no audio available */
    }
  }

  start() {
    this.unlock();
    this.stop();
    if (!this.ctx) return;
    const ring = () => {
      const t = this.ctx.currentTime + 0.05;
      [[0, 523.25], [0.24, 659.25], [0.48, 783.99], [0.9, 659.25]].forEach(([o, f]) => {
        this._tone(t + o, f, 0.075, 1.05);
        this._tone(t + o, f * 2, 0.01, 0.65);
      });
    };
    ring();
    this.timer = setInterval(ring, 4800);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const osc of this.oscillators) {
      try { osc.stop(); } catch { /* already finished */ }
    }
    this.oscillators.clear();
  }

  _tone(t, freq, volume, dur) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    this.oscillators.add(osc);
    osc.onended = () => {
      this.oscillators.delete(osc);
      osc.disconnect();
      gain.disconnect();
    };
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
}

/** Next time the clock shows HH:MM, strictly after `from`. */
export function nextOccurrence(time, from) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
