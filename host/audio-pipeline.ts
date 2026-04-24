import { spawn } from "node:child_process";
import { SAMPLE_RATE } from "./clock.ts";

export type DecodedTrack = {
  samples: Int16Array;
  numFrames: number;
  sampleRate: number;
  channels: 2;
  durationSec: number;
  name: string;
  originalPath: string;
  // Populated only for URL-sourced tracks — the per-video URL (for a playlist,
  // this is the individual video's URL, not the playlist URL). Used to offer
  // a "favourite this" action on the queue UI.
  sourceUrl?: string;
};

export async function decodeFileToPcm(
  filePath: string,
  displayName: string,
): Promise<DecodedTrack> {
  return decodeAt(filePath, displayName, SAMPLE_RATE);
}

export async function resampleTrackTo(
  originalPath: string,
  displayName: string,
  targetRate: number,
): Promise<DecodedTrack> {
  return decodeAt(originalPath, displayName, targetRate);
}

function decodeAt(
  filePath: string,
  displayName: string,
  targetRate: number,
): Promise<DecodedTrack> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(targetRate),
      "-ac", "2",
      "-",
    ];
    console.log(`[ffmpeg] spawn: ffmpeg ${args.join(" ")}`);
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let bytesOut = 0;
    ff.stdout.on("data", (b: Buffer) => {
      chunks.push(b);
      bytesOut += b.byteLength;
    });
    ff.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) console.log(`[ffmpeg:stderr] ${line}`);
      }
    });
    ff.on("error", (err) => {
      console.error(`[ffmpeg] spawn error: ${(err as Error).message}`);
      reject(err);
    });
    ff.on("close", (code) => {
      console.log(`[ffmpeg] exited code=${code} pcmBytes=${bytesOut} rate=${targetRate}`);
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
        sampleRate: targetRate,
        channels: 2,
        durationSec: numFrames / targetRate,
        name: displayName,
        originalPath: filePath,
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
