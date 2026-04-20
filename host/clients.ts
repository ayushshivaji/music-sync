import type { WebSocket } from "ws";
import type { Channel } from "./clock.ts";

export type AudioClient = {
  id: string;
  ws: WebSocket;
  name: string;
  channel: Channel;
  remoteAddr: string;
  connectedAtNs: bigint;
  framesLate: number;
  nextSendFrame: number;
};

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

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
