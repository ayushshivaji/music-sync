# music-sync

Yes, WebSockets carry everything — there is no UDP, no HTTP streaming for audio, nothing exotic. Two WS endpoints on the same port (7500):

- `/ws` — one per browser client. Carries **both** clock-sync JSON messages **and** binary audio frames.
- `/ctl` — one per open host-UI tab. Carries control (`play`, `pause`, `seek`, `forceSync`, rename/assign) and state broadcasts.

Files: `host/index.ts:123-135` for the upgrade routing; binary audio send at `host/scheduler.ts:193`; client receive at `client/client.js:67-70`.

## Why "sounds together" is possible over LAN WebSockets

The hard problem isn't *transport* — a home Wi-Fi WS connection has only 2–15 ms of jitter — it's **agreeing on time**. Once every client knows the host's clock, any one of them can be told "play this chunk at host-time T", and if T is far enough in the future, everyone hits it together. The scheme has three parts: clock sync, scheduled playback, and a lookahead buffer that absorbs jitter.

## 1. Clock sync — NTP-lite

Standard 3-timestamp round trip, running on the same `/ws`:

1. Client sends `{type:"ping", t0: clientMonoNow}`.
2. Host replies `{type:"pong", t0, t1: hostMonoNow}` (`host/index.ts:159-162`).
3. Client records `t2 = clientMonoNow` on receipt.

RTT = `t2 − t0`. Under the assumption that the network is symmetric, the host was at `t1` at the client moment `(t0 + t2) / 2`. That's one sample. The client keeps a rolling window of 40 samples (`WINDOW_SIZE` in `client/clock.js:11`) and fits a line with weighted least squares:

```
audioTime ≈ a · hostNs + b
```

- `a` captures the *drift* between the host's monotonic clock and the client's `AudioContext` sample clock (usually within a few hundred ppm).
- `b` captures the *offset* (which side thinks "now" is later).
- Weighting is `1 / (rtt² + 1)` so low-RTT samples dominate — they're the ones where the "symmetric network" assumption holds best (`client/clock.js:85`).

At connection the client fires a burst of 10 pings at 40 ms spacing to fill the regression window fast, then falls back to one ping every 3 seconds for drift tracking (`client/client.js:63-65`).

## 2. Host schedules the timeline

The host decodes the file once with ffmpeg → **48 kHz** 16-bit stereo PCM in memory — that's the *master* copy — and keeps per-rate re-decoded copies around for any client whose `AudioContext.sampleRate` is different (e.g. a Mac set to 44.1 kHz gets its own copy). This way each client receives PCM that already matches its own rate, and Web Audio does zero per-buffer resampling (which otherwise produces continuous polyphase-edge hiss). See `host/audio-pipeline.ts` + `host/scheduler.ts`. Sources: local files, a whole folder (recursed, sorted), or a YouTube / yt-dlp–compatible URL via `POST /upload-url` → `yt-dlp -x --audio-format mp3` → the same decode path. The host owns the single source of truth:

- `playStartHostNs` — the host-monotonic-nanosecond time at which playback started.
- `playStartFrame` — the sample index that corresponds to `playStartHostNs`.
- `state` — `idle` / `paused` / `playing`.
- `epoch` — incremented on play/pause/seek/loadTrack so clients can detect a timeline discontinuity (`host/scheduler.ts:31,46,58,69,82`).

A 50 ms timer (`host/scheduler.ts:142`) runs `tick()`. Each tick:

1. Compute a "horizon": `now + 500 ms` of lookahead.
2. For each connected client, while its `nextSendFrame + MASTER_FRAME_SAMPLES ≤ horizonFrame` (4800 master samples = 100 ms), slice a 100 ms window out of *that client's rate-matched PCM copy*, extract just the channel that client is assigned (left/right/mono/mute via `extractChannel` in `host/audio-pipeline.ts`), and send a binary WS frame with this header:

```
u32 magic   (0x53594e43 "SYNC")
u32 seq
u32 sampleRate         (matches the receiving client's AudioContext rate)
u32 numSamples         (per channel; 100 ms at that rate — 4800 @ 48 kHz, 4410 @ 44.1 kHz)
u8  channels (1 after split)
u8  bitsPerSample (16)
u16 reserved
i64 playAtHostNs        ← the scheduled wall-clock moment
```

followed by `numSamples × 2` bytes of Int16 LE PCM. `playAtHostNs` is deterministic from the master-rate frame index: `playStartHostNs + round(masterFrameIndex · 1e9 / 48000)` (`host/scheduler.ts`). Crucially, `playAtHostNs` is computed from the *master* timeline — so a 48 kHz and a 44.1 kHz client receive different-length PCM chunks that are labelled with the *same* host time for the same song position, and end up playing aligned.

The host is always running *ahead* of real playback by up to 500 ms. That headroom is the jitter buffer.

## 3. Client schedules each frame against its `AudioContext`

When a binary frame arrives (`client/client.js:108`):

1. Parse header, get `playAtHostNs`, the PCM slice, sample rate.
2. Convert `playAtHostNs` → `audioTime` (local `AudioContext.currentTime` units).
3. Build an `AudioBuffer`, wrap it in an `AudioBufferSourceNode`, call `source.start(when)`. Web Audio's `.start(when)` is sample-accurate for a single node, which is what makes aligned playback across clients possible.

The conversion in step 2 is where all the subtlety lives, because **two clients that schedule against slightly different lines will drift apart, and within one client, two consecutive frames on slightly different lines will click at the boundary.** That's exactly what showed up as static before the fix.

## 4. Anchored scheduling (the fix)

Naive version: `audioTime = a · playAtHostNs + b`, re-evaluated per frame. Problem: `a` and `b` are *refit on every pong*. A startup burst at 40 ms spacing nudges the line 10 times in the first 400 ms of playback. Consecutive 100 ms frames land on different lines, so their scheduled start times are offset by ~1–3 ms — an overlap or a gap at every boundary.

Anchored version (`client/client.js`, current code):

```js
if (anchorHostNs === null) {
  const at = clock.hostNsToAudioTime(playAtHostNs);
  if (at === null) { /* fallback until first fit ready */ }
  anchorHostNs   = playAtHostNs;
  anchorAudioTime = at;
  when = at;
} else {
  when = anchorAudioTime + Number(playAtHostNs - anchorHostNs) / 1e9;
}
```

The fit is consulted **once** per playback epoch, to pin `(anchorHostNs, anchorAudioTime)`. After that, every frame's `when` is computed purely by subtraction from the anchor using `playAtHostNs`, which is itself deterministic and 100 ms apart frame-to-frame. So consecutive frames land exactly 100 ms apart in `AudioContext` time. No boundary noise.

The fit keeps improving in the background (more pongs, better line) — it just doesn't retroactively move frames that are already scheduled. The anchor is discarded and re-picked on:

- WS reconnect,
- `transport` message with a new `epoch` (play/pause/seek on the host),
- the `resync` message sent by **Force sync**.

## 5. Dropping late frames

If `when < ctx.currentTime + 20ms` (the `SCHEDULE_SAFETY_SEC` in `client/client.js:5`), the frame is already past its safe-schedule deadline. The client drops it, increments `framesLate`, and reports the running total back to the host with `{type:"late", count}`. The host's UI shows that number in the **Late** column — it's the primary health signal. Steady zero = the 500 ms lookahead is comfortably absorbing network jitter; rising number = network or clock is in trouble, and Force sync is the hammer.

## 6. Force sync

Host UI → `/ctl`: `{type:"forceSync"}`. Server (`host/index.ts`) rebroadcasts `{type:"resync"}` to every `/ws` client and zeros each client's `framesLate`. Each client cancels its scheduled `AudioBufferSourceNode`s, clears its anchor, resets the ClockSync fit, and fires a fresh 10-ping burst. The next audio frame re-anchors cleanly. Audio doesn't pause — the host keeps feeding frames from its 500 ms buffer while the client rebuilds its timing.

## What the 500 ms buffer buys you

Every audio frame is sent with a `playAtHostNs` 500 ms in the future of when it's sent. On LAN the frame typically arrives within 5–15 ms. That leaves ~485 ms of slack for WS/TCP jitter, GC pauses, OS scheduler hiccups, and browser event-loop lag before a frame becomes "late". That's why TCP WebSockets are fine here — you'd think TCP head-of-line blocking would hurt audio, but the buffer is an order of magnitude larger than any realistic hiccup in a home network.
