import type { WebSocket } from "ws";
import { SAMPLE_RATE, type Channel } from "./clock.ts";

export type AudioClient = {
  id: string;
  ws: WebSocket;
  name: string;
  channel: Channel;
  remoteAddr: string;
  connectedAtNs: bigint;
  framesLate: number;
  // Position on the host timeline in MASTER-rate samples.
  nextSendFrame: number;
  // Client's AudioContext.sampleRate; default to master until announced.
  sampleRate: number;
  // Linear 0..1 gain applied on the client (via a shared GainNode).
  volume: number;
};

export const DEFAULT_CLIENT_RATE = SAMPLE_RATE;

let nextId = 1;
export function mintClientId(): string {
  return `c${nextId++}`;
}

export class ClientRegistry {
  private clients = new Map<string, AudioClient>();
  private listeners = new Set<() => void>();

  add(c: AudioClient): void {
    this.clients.set(c.id, c);
    this.notify();
  }

  remove(id: string): void {
    this.clients.delete(id);
    this.notify();
  }

  get(id: string): AudioClient | undefined {
    return this.clients.get(id);
  }

  all(): AudioClient[] {
    return [...this.clients.values()];
  }

  setChannel(id: string, channel: Channel): void {
    const c = this.clients.get(id);
    if (!c) return;
    c.channel = channel;
    this.notify();
  }

  setName(id: string, name: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    c.name = name;
    this.notify();
  }

  setRate(id: string, sampleRate: number): void {
    const c = this.clients.get(id);
    if (!c) return;
    if (c.sampleRate === sampleRate) return;
    c.sampleRate = sampleRate;
    this.notify();
  }

  setVolume(id: string, volume: number): void {
    const c = this.clients.get(id);
    if (!c) return;
    const clamped = Math.max(0, Math.min(1, volume));
    if (c.volume === clamped) return;
    c.volume = clamped;
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
