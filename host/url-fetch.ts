import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename } from "node:path";

export type FetchedFile = { path: string; displayName: string; sourceUrl: string };

export type FetchOptions = {
  uploadDir: string;
  playlistLimit: number;     // max tracks to pull from a playlist URL
  signal?: AbortSignal;
  // Called once per track as soon as yt-dlp finishes downloading + extracting.
  // Awaited so the caller can decode + enqueue in order before the next line.
  onTrack: (file: FetchedFile) => Promise<void> | void;
};

// Spawns yt-dlp, streams each completed track through `onTrack` as it lands,
// and resolves once yt-dlp exits. Works for single videos and playlists;
// the URL's playlist context is followed up to `playlistLimit` items.
// Returns the total number of tracks that were successfully handed off.
export async function fetchAudioFromUrl(
  url: string,
  opts: FetchOptions,
): Promise<{ count: number }> {
  await mkdir(opts.uploadDir, { recursive: true });
  const args = [
    "--playlist-end", String(Math.max(1, Math.floor(opts.playlistLimit))),
    "--ignore-errors",
    "--no-warnings",
    "--no-progress",
    "-q",
    "--max-filesize", "500M",
    "--socket-timeout", "30",
    "-P", opts.uploadDir,
    "-o", "%(playlist_index&{}. |)s%(title).160B [%(id)s].%(ext)s",
    "-x",
    "--audio-format", "mp3",
    // Tab-separated so we can pair webpage_url with filepath per completed
    // track. webpage_url is the per-video URL — for a playlist URL, each
    // entry prints its own video URL, not the playlist URL.
    "--print", `after_move:%(webpage_url)s\t%(filepath)s`,
    url,
  ];
  console.log(
    `[yt-dlp] spawn: yt-dlp ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
  );
  const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (opts.signal) {
    const abort = () => child.kill("SIGTERM");
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }

  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    stderr += s;
    for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`[yt-dlp:stderr] ${line}`);
  });

  const rl = createInterface({ input: child.stdout });
  let count = 0;
  let onTrackQueue: Promise<void> = Promise.resolve();
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    // With `-q --print after_move:<webpage_url>\t<filepath>`, each non-empty
    // stdout line should be URL<TAB>PATH. If the split fails we fall back to
    // treating the line as a bare path (older yt-dlp builds, weird field
    // substitution, etc.).
    const tab = line.indexOf("\t");
    let sourceUrl = "";
    let filepath = line;
    if (tab >= 0) {
      sourceUrl = line.slice(0, tab).trim();
      filepath = line.slice(tab + 1).trim();
    }
    if (!filepath.startsWith("/")) {
      console.log(`[yt-dlp] ${line}`);
      return;
    }
    console.log(`[yt-dlp] ${filepath}${sourceUrl ? `  (url=${sourceUrl})` : ""}`);
    const file: FetchedFile = {
      path: filepath,
      displayName: basename(filepath),
      sourceUrl,
    };
    count++;
    // Serialize onTrack calls — decoding is CPU-bound and order matters for queue.
    onTrackQueue = onTrackQueue.then(async () => {
      try {
        await opts.onTrack(file);
      } catch (err) {
        console.error(`[yt-dlp] onTrack error for ${filepath}: ${(err as Error).message}`);
      }
    });
  });

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 0));
  });
  await onTrackQueue;

  if (code !== 0 && count === 0) {
    throw new Error(stderr.trim() || `yt-dlp exited ${code}`);
  }
  if (code !== 0) {
    console.log(`[yt-dlp] finished with exit=${code} but ${count} track(s) queued; continuing.`);
  }
  return { count };
}
