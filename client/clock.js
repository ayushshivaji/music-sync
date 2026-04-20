// Client-side clock offset estimator.
// Estimates offset such that: hostMonoNs ≈ clientMonoNs + offsetNs
// plus an anchor mapping host monotonic ns → AudioContext.currentTime.

const MAX_SAMPLES = 20;

export class ClockSync {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.samples = [];
    this.offsetNs = null;
    this.rttNs = null;
    this.anchorHostNs = null;
    this.anchorAudioTime = null;
    this.listeners = new Set();
  }

  nowNs() {
    return BigInt(Math.round(performance.timeOrigin * 1e6) + Math.round(performance.now() * 1e6));
  }

  handlePong(t0Ns, t1HostNs) {
    const t2Ns = this.nowNs();
    const t0 = BigInt(t0Ns);
    const t1 = BigInt(t1HostNs);
    const rtt = t2Ns - t0;
    const offset = t1 - ((t0 + t2Ns) / 2n);
    this.samples.push({ rtt, offset, audioTime: this.ctx.currentTime, clientNs: t2Ns });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offsetNs = best.offset;
    this.rttNs = best.rtt;
    this.anchorHostNs = best.clientNs + best.offset;
    this.anchorAudioTime = best.audioTime;
    this.notify();
  }

  ready() {
    return this.offsetNs !== null && this.anchorAudioTime !== null;
  }

  hostNsToAudioTime(hostNs) {
    if (!this.ready()) return null;
    const deltaNs = BigInt(hostNs) - this.anchorHostNs;
    return this.anchorAudioTime + Number(deltaNs) / 1e9;
  }

  rttMs() {
    return this.rttNs === null ? null : Number(this.rttNs) / 1e6;
  }

  offsetMs() {
    return this.offsetNs === null ? null : Number(this.offsetNs) / 1e6;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { for (const fn of this.listeners) fn(); }
}
