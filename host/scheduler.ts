import {
  encodeFrame,
  FRAME_DURATION_SEC,
  MASTER_FRAME_SAMPLES,
  nowNs,
  SAMPLE_RATE,
} from "./clock.ts";
import {
  extractChannel,
  resampleTrackTo,
  type DecodedTrack,
} from "./audio-pipeline.ts";
import type { ClientRegistry, AudioClient } from "./clients.ts";

const LOOKAHEAD_NS = 500_000_000n;
const TICK_MS = 50;

export type TransportState = "idle" | "playing" | "paused";

export type TransportSnapshot = {
  state: TransportState;
  trackName: string | null;
  trackUrl: string | null;
  durationSec: number;
  positionSec: number;
  queue: Array<{ name: string; durationSec: number; sourceUrl?: string }>;
};

type TransportMsg = {
  type: "transport";
  state: TransportState;
  positionNs: string;
  hostNowNs: string;
  epoch: number;
};

export class Scheduler {
  private masterTrack: DecodedTrack | null = null;
  private tracksByRate: Map<number, DecodedTrack> = new Map();
  private ratePending: Set<number> = new Set();
  private queue: DecodedTrack[] = [];
  private state: TransportState = "idle";
  private playStartHostNs: bigint = 0n;
  // Positions are in MASTER-rate samples.
  private playStartFrame: number = 0;
  private pausedAtFrame: number = 0;
  private epoch: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextSeq: number = 1;
  private changeListeners = new Set<() => void>();

  constructor(private registry: ClientRegistry) {
    registry.onChange(() => {
      this.ensureRatesForClients();
      this.notify();
    });
  }

  loadTrack(track: DecodedTrack): void {
    this.stopTimer();
    this.masterTrack = track;
    this.tracksByRate = new Map();
    this.tracksByRate.set(track.sampleRate, track);
    this.ratePending = new Set();
    this.state = "paused";
    this.pausedAtFrame = 0;
    this.playStartFrame = 0;
    this.epoch++;
    for (const c of this.registry.all()) c.nextSendFrame = 0;
    console.log(
      `[scheduler] loadTrack: name="${track.name}" ` +
      `durationSec=${track.durationSec.toFixed(3)} numFrames=${track.numFrames} ` +
      `masterRate=${track.sampleRate} clients=${this.registry.all().length}`
    );
    this.ensureRatesForClients();
    this.broadcastTransport();
    this.notify();
  }

  play(): void {
    if (!this.masterTrack) {
      console.log("[scheduler] play ignored: no track loaded");
      return;
    }
    if (this.state === "playing") {
      console.log("[scheduler] play ignored: already playing");
      return;
    }
    let startFrame = this.pausedAtFrame;
    if (startFrame >= this.masterTrack.numFrames) {
      console.log("[scheduler] play: at/past end of track, restarting from 0");
      startFrame = 0;
    }
    this.pausedAtFrame = startFrame;
    this.playStartFrame = startFrame;
    this.playStartHostNs = nowNs();
    this.state = "playing";
    this.epoch++;
    for (const c of this.registry.all()) c.nextSendFrame = startFrame;
    console.log(
      `[scheduler] play: epoch=${this.epoch} startFrame=${startFrame} ` +
      `clients=${this.registry.all().length}`
    );
    this.broadcastTransport();
    this.startTimer();
    this.notify();
  }

  pause(): void {
    if (!this.masterTrack || this.state !== "playing") return;
    this.pausedAtFrame = this.currentFrame();
    this.state = "paused";
    this.epoch++;
    this.stopTimer();
    this.broadcastTransport();
    this.notify();
  }

  seek(positionSec: number): void {
    if (!this.masterTrack) return;
    const frame = Math.max(
      0,
      Math.min(this.masterTrack.numFrames, Math.floor(positionSec * SAMPLE_RATE)),
    );
    const wasPlaying = this.state === "playing";
    this.stopTimer();
    this.pausedAtFrame = frame;
    this.state = "paused";
    this.epoch++;
    for (const c of this.registry.all()) c.nextSendFrame = frame;
    this.broadcastTransport();
    if (wasPlaying) this.play();
    else this.notify();
  }

  snapshot(): TransportSnapshot {
    return {
      state: this.state,
      trackName: this.masterTrack?.name ?? null,
      trackUrl: this.masterTrack?.sourceUrl ?? null,
      durationSec: this.masterTrack?.durationSec ?? 0,
      positionSec: this.currentFrame() / SAMPLE_RATE,
      queue: this.queue.map((t) => ({
        name: t.name,
        durationSec: t.durationSec,
        sourceUrl: t.sourceUrl,
      })),
    };
  }

  enqueue(track: DecodedTrack): void {
    this.queue.push(track);
    console.log(
      `[scheduler] enqueue: name="${track.name}" queueLen=${this.queue.length} ` +
      `hasCurrent=${this.masterTrack !== null}`
    );
    if (!this.masterTrack) {
      // First upload becomes the current track immediately, paused at 0.
      this.advance(false);
    } else {
      this.notify();
    }
  }

  skipNext(): void {
    if (this.queue.length === 0) {
      console.log("[scheduler] skipNext ignored: queue empty");
      return;
    }
    this.advance(true);
  }

  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    const removed = this.queue.splice(index, 1)[0];
    if (!removed) return;
    console.log(
      `[scheduler] removeFromQueue: index=${index} name="${removed.name}" ` +
      `remaining=${this.queue.length}`
    );
    this.notify();
  }

  moveQueued(fromIndex: number, toIndex: number): void {
    const n = this.queue.length;
    if (fromIndex < 0 || fromIndex >= n) return;
    const clampedTo = Math.max(0, Math.min(n - 1, toIndex));
    if (fromIndex === clampedTo) return;
    const item = this.queue.splice(fromIndex, 1)[0];
    if (!item) return;
    this.queue.splice(clampedTo, 0, item);
    console.log(
      `[scheduler] moveQueued: from=${fromIndex} to=${clampedTo} name="${item.name}"`
    );
    this.notify();
  }

  clearQueue(): void {
    if (this.queue.length === 0) return;
    console.log(`[scheduler] clearQueue: cleared=${this.queue.length}`);
    this.queue = [];
    this.notify();
  }

  private advance(autoPlay: boolean): void {
    const next = this.queue.shift();
    if (!next) {
      // End of queue: stop at the end of the current track.
      console.log("[scheduler] advance: queue empty, stopping");
      this.stopTimer();
      if (this.state === "playing") {
        this.pausedAtFrame = this.currentFrame();
      }
      this.state = "paused";
      this.epoch++;
      this.broadcastTransport();
      this.notify();
      return;
    }
    console.log(
      `[scheduler] advance: next="${next.name}" autoPlay=${autoPlay} ` +
      `remaining=${this.queue.length}`
    );
    this.loadTrack(next);
    if (autoPlay) this.play();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  sendTransportTo(client: AudioClient): void {
    const msg = this.transportMsg();
    try { client.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  async ensureRate(rate: number): Promise<void> {
    if (!this.masterTrack) return;
    if (this.tracksByRate.has(rate)) return;
    if (this.ratePending.has(rate)) return;
    this.ratePending.add(rate);
    const masterAtStart = this.masterTrack;
    console.log(`[scheduler] ensureRate: resampling ${this.masterTrack.sampleRate} → ${rate}`);
    try {
      const resampled = await resampleTrackTo(
        masterAtStart.originalPath,
        masterAtStart.name,
        rate,
      );
      // If the master has been replaced while we were resampling, drop this result.
      if (this.masterTrack !== masterAtStart) {
        console.log(`[scheduler] ensureRate: discarding stale resample for rate=${rate}`);
        return;
      }
      this.tracksByRate.set(rate, resampled);
      console.log(
        `[scheduler] ensureRate: cached rate=${rate} ` +
        `numFrames=${resampled.numFrames} durationSec=${resampled.durationSec.toFixed(3)}`
      );
      this.notify();
    } catch (err) {
      console.error(`[scheduler] ensureRate failed for rate=${rate}: ${(err as Error).message}`);
    } finally {
      this.ratePending.delete(rate);
    }
  }

  private ensureRatesForClients(): void {
    if (!this.masterTrack) return;
    const wanted = new Set<number>();
    for (const c of this.registry.all()) wanted.add(c.sampleRate);
    for (const r of wanted) {
      if (!this.tracksByRate.has(r) && !this.ratePending.has(r)) {
        void this.ensureRate(r);
      }
    }
  }

  private broadcastTransport(): void {
    const msg = JSON.stringify(this.transportMsg());
    for (const c of this.registry.all()) {
      try { c.ws.send(msg); } catch { /* ignore */ }
    }
  }

  private transportMsg(): TransportMsg {
    const positionNs = BigInt(this.currentFrame()) * 1_000_000_000n / BigInt(SAMPLE_RATE);
    return {
      type: "transport",
      state: this.state,
      positionNs: positionNs.toString(),
      hostNowNs: nowNs().toString(),
      epoch: this.epoch,
    };
  }

  private currentFrame(): number {
    if (this.state !== "playing" || !this.masterTrack) return this.pausedAtFrame;
    const elapsedNs = nowNs() - this.playStartHostNs;
    const elapsedFrames = Number(elapsedNs) * SAMPLE_RATE / 1e9;
    const frame = this.playStartFrame + Math.floor(elapsedFrames);
    return Math.min(frame, this.masterTrack.numFrames);
  }

  private frameToHostNs(frame: number): bigint {
    const relFrames = frame - this.playStartFrame;
    const relNs = BigInt(Math.round(relFrames * 1e9 / SAMPLE_RATE));
    return this.playStartHostNs + relNs;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.masterTrack || this.state !== "playing") return;
    const masterNumFrames = this.masterTrack.numFrames;
    const horizonNs = nowNs() + LOOKAHEAD_NS;
    const horizonRelSec = Number(horizonNs - this.playStartHostNs) / 1e9;
    const horizonFrame = Math.min(
      masterNumFrames,
      this.playStartFrame + Math.ceil(horizonRelSec * SAMPLE_RATE),
    );

    let anyClient = false;
    for (const c of this.registry.all()) {
      anyClient = true;
      const clientTrack = this.tracksByRate.get(c.sampleRate);
      if (!clientTrack) {
        // Rate cache not ready yet. Advance c.nextSendFrame so when the cache
        // lands the client jumps in live rather than trying to catch up with
        // silence-filled past frames.
        if (c.nextSendFrame + MASTER_FRAME_SAMPLES <= horizonFrame) {
          c.nextSendFrame += MASTER_FRAME_SAMPLES;
        }
        continue;
      }
      while (c.nextSendFrame + MASTER_FRAME_SAMPLES <= horizonFrame) {
        this.sendAudioFrame(c, clientTrack, c.nextSendFrame, MASTER_FRAME_SAMPLES);
        c.nextSendFrame += MASTER_FRAME_SAMPLES;
      }
      // Tail: send whatever's left up to masterNumFrames.
      if (
        c.nextSendFrame < masterNumFrames &&
        c.nextSendFrame >= masterNumFrames - MASTER_FRAME_SAMPLES
      ) {
        const tail = masterNumFrames - c.nextSendFrame;
        if (tail > 0 && c.nextSendFrame + tail <= horizonFrame) {
          this.sendAudioFrame(c, clientTrack, c.nextSendFrame, tail);
          c.nextSendFrame += tail;
        }
      }
    }

    if (anyClient && this.currentFrame() >= masterNumFrames) {
      if (this.queue.length > 0) {
        this.advance(true);
      } else {
        this.pause();
      }
    }
  }

  private sendAudioFrame(
    c: AudioClient,
    clientTrack: DecodedTrack,
    startMasterFrame: number,
    masterFrames: number,
  ): void {
    if (!this.masterTrack) return;
    if (c.channel === "mute") {
      this.nextSeq++;
      return;
    }
    const channel = c.channel === "left" || c.channel === "right" ? c.channel : "mono";
    // Translate master-rate position to the client's rate.
    const rateScale = c.sampleRate / SAMPLE_RATE;
    const startClientFrame = Math.round(startMasterFrame * rateScale);
    const clientChunkFrames = Math.max(
      1,
      Math.min(
        clientTrack.numFrames - startClientFrame,
        Math.round(masterFrames * rateScale),
      ),
    );
    const pcm = extractChannel(clientTrack, startClientFrame, clientChunkFrames, channel);
    const playAt = this.frameToHostNs(startMasterFrame);
    const frame = encodeFrame(
      this.nextSeq++,
      c.sampleRate,
      clientChunkFrames,
      playAt,
      pcm,
    );
    try {
      c.ws.send(frame);
    } catch {
      /* ignore; client will be cleaned up on close */
    }
  }

  private notify(): void {
    for (const fn of this.changeListeners) fn();
  }
}
