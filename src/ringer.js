// Phone-style ringtone made with WebAudio, so there is no audio file to ship.
// Browsers only let audio start after the user has interacted with the page,
// so the context is unlocked on the first tap and reused when the alarm fires.

export class Ringer {
  constructor() {
    this.ctx = null;
    this.timer = null;
  }

  get unlocked() {
    return this.ctx?.state === 'running';
  }

  unlock() {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
      [[0, 880], [0.25, 660], [0.5, 880], [0.75, 660]].forEach(([o, f]) => this._beep(t + o, f, 0.2));
    };
    ring();
    this.timer = setInterval(ring, 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _beep(t, freq, dur) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
    gain.gain.setValueAtTime(0.3, t + dur - 0.03);
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
