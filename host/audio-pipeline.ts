import { spawn } from "node:child_process";
import { SAMPLE_RATE } from "./clock.ts";

export type DecodedTrack = {
  samples: Int16Array;
  numFrames: number;
  sampleRate: number;
  channels: 2;
  durationSec: number;
  name: string;
};

export async function decodeFileToPcm(
  filePath: string,
  displayName: string,
): Promise<DecodedTrack> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", "2",
      "-",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    ff.stdout.on("data", (b: Buffer) => chunks.push(b));
    ff.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      const numFrames = samples.length / 2;
      resolve({
        samples,
        numFrames,
        sampleRate: SAMPLE_RATE,
        channels: 2,
        durationSec: numFrames / SAMPLE_RATE,
        name: displayName,
      });
    });
  });
}

export function extractChannel(
  track: DecodedTrack,
  startFrame: number,
  numFrames: number,
  channel: "left" | "right" | "mono",
): Int16Array {
  const src = track.samples;
  const out = new Int16Array(numFrames);
  const totalFrames = track.numFrames;
  for (let i = 0; i < numFrames; i++) {
    const f = startFrame + i;
    if (f >= totalFrames) break;
    const l = src[f * 2] ?? 0;
    const r = src[f * 2 + 1] ?? 0;
    if (channel === "left") out[i] = l;
    else if (channel === "right") out[i] = r;
    else out[i] = ((l + r) / 2) | 0;
  }
  return out;
}
