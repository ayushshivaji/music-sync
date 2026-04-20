export function nowNs(): bigint {
  return process.hrtime.bigint();
}

export function nsToSeconds(ns: bigint): number {
  return Number(ns) / 1e9;
}

export const FRAME_MAGIC = 0x53594e43;
export const FRAME_HEADER_BYTES = 32;
export const SAMPLE_RATE = 44100;
export const FRAME_SAMPLES = 4410;

export type Channel = "left" | "right" | "mono" | "mute";

export function encodeFrame(
  seq: number,
  sampleRate: number,
  numSamples: number,
  playAtHostNs: bigint,
  pcm: Int16Array,
): Buffer {
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = Buffer.alloc(FRAME_HEADER_BYTES + body.byteLength);
  out.writeUInt32LE(FRAME_MAGIC, 0);
  out.writeUInt32LE(seq >>> 0, 4);
  out.writeUInt32LE(sampleRate, 8);
  out.writeUInt32LE(numSamples, 12);
  out.writeUInt8(1, 16);
  out.writeUInt8(16, 17);
  out.writeUInt16LE(0, 18);
  out.writeBigInt64LE(playAtHostNs, 20);
  body.copy(out, FRAME_HEADER_BYTES);
  return out;
}
