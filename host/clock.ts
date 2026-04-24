export function nowNs(): bigint {
  return process.hrtime.bigint();
}

export function nsToSeconds(ns: bigint): number {
  return Number(ns) / 1e9;
}

export const FRAME_MAGIC = 0x53594e43;
export const FRAME_HEADER_BYTES = 32;
// Master rate used for the host's timeline math. Matches macOS Core Audio's
// native rate so 48 kHz clients need no resampling at all.
export const SAMPLE_RATE = 48000;
export const FRAME_DURATION_SEC = 0.1;
export const MASTER_FRAME_SAMPLES = Math.round(FRAME_DURATION_SEC * SAMPLE_RATE);
// Legacy alias for callers that still treat frames at the master rate.
export const FRAME_SAMPLES = MASTER_FRAME_SAMPLES;

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
