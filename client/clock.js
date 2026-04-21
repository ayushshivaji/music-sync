// Client-side clock sync with drift compensation.
//
// We fit a line through recent ping/pong samples:
//     audioTime ≈ a * hostNs + b
// where `a` captures the drift between the host's monotonic clock and the
// client's AudioContext sample clock, and `b` captures the offset. A single
// anchor (a=1e-9 frozen) drifts ~1–6ms per minute; weighted LSQ over a rolling
// window of samples keeps alignment to the target (~20ms) for arbitrarily
// long tracks.

const WINDOW_SIZE = 40;
const MIN_SAMPLES_FOR_FIT = 3;

export class ClockSync {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.samples = [];
    this.a = null;
    this.b = null;
    this.bestRttNs = null;
    this.residualMs = null;
    this.listeners = new Set();
  }

  nowNs() {
    return BigInt(
      Math.round(performance.timeOrigin * 1e6) + Math.round(performance.now() * 1e6),
    );
  }

  handlePong(t0Num, t1Num) {
    const t2 = this.nowNs();
    const t0 = BigInt(t0Num);
    const t1 = BigInt(t1Num);
    const rtt = t2 - t0;
    if (rtt < 0n) return;
    // Midpoint assumption: at client ns (t0+t2)/2, host ns was t1.
    // AudioContext.currentTime at that client moment ≈ currentTime - rtt/2.
    const sample = {
      rtt,
      hostNs: t1,
      clientNs: (t0 + t2) / 2n,
      audioTime: this.ctx.currentTime - Number(rtt) / 2e9,
    };
    this.samples.push(sample);
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
    this.refit();
    if (this.ready()) {
      const predicted = this.a * Number(sample.hostNs) + this.b;
      this.residualMs = (sample.audioTime - predicted) * 1e3;
    }
    this.notify();
  }

  reset() {
    this.samples = [];
    this.a = null;
    this.b = null;
    this.bestRttNs = null;
    this.residualMs = null;
    this.notify();
  }

  refit() {
    if (this.samples.length === 0) return;
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.bestRttNs = best.rtt;

    const threshold = best.rtt * 3n;
    const good = this.samples.filter((s) => s.rtt <= threshold);

    if (good.length < MIN_SAMPLES_FOR_FIT) {
      this.a = 1e-9;
      this.b = best.audioTime - this.a * Number(best.hostNs);
      return;
    }

    const hostRef = good[0].hostNs;
    let sumW = 0, sumWx = 0, sumWy = 0, sumWxx = 0, sumWxy = 0;
    for (const s of good) {
      const x = Number(s.hostNs - hostRef);
      const y = s.audioTime;
      const rttNs = Number(s.rtt);
      const w = 1 / (rttNs * rttNs + 1);
      sumW += w;
      sumWx += w * x;
      sumWy += w * y;
      sumWxx += w * x * x;
      sumWxy += w * x * y;
    }
    const denom = sumW * sumWxx - sumWx * sumWx;
    if (denom === 0) {
      this.a = 1e-9;
      this.b = best.audioTime - this.a * Number(best.hostNs);
      return;
    }
    const a = (sumW * sumWxy - sumWx * sumWy) / denom;
    const bRel = (sumWy - a * sumWx) / sumW;
    this.a = a;
    this.b = bRel - a * Number(hostRef);
  }

  ready() {
    return this.a !== null;
  }

  hostNsToAudioTime(hostNs) {
    if (!this.ready()) return null;
    return this.a * Number(BigInt(hostNs)) + this.b;
  }

  rttMs() {
    return this.bestRttNs === null ? null : Number(this.bestRttNs) / 1e6;
  }

  residualMsLatest() {
    return this.residualMs;
  }

  driftPpm() {
    if (this.a === null) return null;
    return (this.a / 1e-9 - 1) * 1e6;
  }

  sampleCount() {
    return this.samples.length;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { for (const fn of this.listeners) fn(); }
}
