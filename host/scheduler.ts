import { encodeFrame, FRAME_SAMPLES, nowNs, SAMPLE_RATE } from "./clock.ts";
import { extractChannel, type DecodedTrack } from "./audio-pipeline.ts";
import type { ClientRegistry, AudioClient } from "./clients.ts";

const LOOKAHEAD_NS = 500_000_000n;
const TICK_MS = 50;

export type TransportState = "idle" | "playing" | "paused";

export type TransportSnapshot = {
  state: TransportState;
  trackName: string | null;
  durationSec: number;
  positionSec: number;
};

type TransportMsg = {
  type: "transport";
  state: TransportState;
  positionNs: string;
  hostNowNs: string;
  epoch: number;
};

export class Scheduler {
  private track: DecodedTrack | null = null;
  private state: TransportState = "idle";
  private playStartHostNs: bigint = 0n;
  private playStartFrame: number = 0;
  private pausedAtFrame: number = 0;
  private epoch: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextSeq: number = 1;
  private changeListeners = new Set<() => void>();

  constructor(private registry: ClientRegistry) {
    registry.onChange(() => this.notify());
  }

  loadTrack(track: DecodedTrack): void {
    this.stopTimer();
    this.track = track;
    this.state = "paused";
    this.pausedAtFrame = 0;
    this.playStartFrame = 0;
    this.epoch++;
    for (const c of this.registry.all()) c.nextSendFrame = 0;
    this.broadcastTransport();
    this.notify();
  }

  play(): void {
    if (!this.track || this.state === "playing") return;
    const startFrame = this.pausedAtFrame;
    this.playStartFrame = startFrame;
    this.playStartHostNs = nowNs();
    this.state = "playing";
    this.epoch++;
    for (const c of this.registry.all()) c.nextSendFrame = startFrame;
    this.broadcastTransport();
    this.startTimer();
    this.notify();
  }

  pause(): void {
    if (!this.track || this.state !== "playing") return;
    this.pausedAtFrame = this.currentFrame();
    this.state = "paused";
    this.epoch++;
    this.stopTimer();
    this.broadcastTransport();
    this.notify();
  }

  seek(positionSec: number): void {
    if (!this.track) return;
    const frame = Math.max(0, Math.min(this.track.numFrames, Math.floor(positionSec * SAMPLE_RATE)));
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
      trackName: this.track?.name ?? null,
      durationSec: this.track?.durationSec ?? 0,
      positionSec: this.currentFrame() / SAMPLE_RATE,
    };
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  sendTransportTo(client: AudioClient): void {
    const msg = this.transportMsg();
    try { client.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
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
    if (this.state !== "playing" || !this.track) return this.pausedAtFrame;
    const elapsedNs = nowNs() - this.playStartHostNs;
    const elapsedFrames = Number(elapsedNs) * SAMPLE_RATE / 1e9;
    const frame = this.playStartFrame + Math.floor(elapsedFrames);
    return Math.min(frame, this.track.numFrames);
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
    if (!this.track || this.state !== "playing") return;
    const horizonNs = nowNs() + LOOKAHEAD_NS;
    const horizonRelSec = Number(horizonNs - this.playStartHostNs) / 1e9;
    const horizonFrame = Math.min(
      this.track.numFrames,
      this.playStartFrame + Math.ceil(horizonRelSec * SAMPLE_RATE),
    );

    let anyClient = false;
    for (const c of this.registry.all()) {
      anyClient = true;
      while (c.nextSendFrame + FRAME_SAMPLES <= horizonFrame) {
        this.sendAudioFrame(c, c.nextSendFrame, FRAME_SAMPLES);
        c.nextSendFrame += FRAME_SAMPLES;
      }
      if (c.nextSendFrame < this.track.numFrames && c.nextSendFrame >= this.track.numFrames - FRAME_SAMPLES) {
        const tail = this.track.numFrames - c.nextSendFrame;
        if (tail > 0 && c.nextSendFrame + tail <= horizonFrame) {
          this.sendAudioFrame(c, c.nextSendFrame, tail);
          c.nextSendFrame += tail;
        }
      }
    }

    if (anyClient && this.currentFrame() >= this.track.numFrames) {
      this.pause();
    }
  }

  private sendAudioFrame(c: AudioClient, startFrame: number, numFrames: number): void {
    if (!this.track) return;
    if (c.channel === "mute") {
      this.nextSeq++;
      return;
    }
    const channel = c.channel === "left" || c.channel === "right" ? c.channel : "mono";
    const pcm = extractChannel(this.track, startFrame, numFrames, channel);
    const playAt = this.frameToHostNs(startFrame);
    const frame = encodeFrame(this.nextSeq++, SAMPLE_RATE, numFrames, playAt, pcm);
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
