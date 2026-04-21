# music-sync — Design

## Context

Goal: turn multiple Macs on the same Wi-Fi into a coordinated speaker array — e.g. two laptops acting as left/right of a stereo pair. Sync target is "sounds together" (~20ms skew), not true <5ms stereo imaging, which keeps the architecture simple. Source for v1 is local audio files on a host Mac; YouTube ingest is deferred to a later milestone.

Tight sync on LAN is achievable because:
- Wi-Fi one-way latency within a home AP is typically 2–10ms with jitter ~5–15ms.
- Scheduling playback at a **future wall-clock time** (host says "play sample S at T+500ms") absorbs that jitter entirely as long as the buffer > jitter.
- The Web Audio API provides sample-accurate scheduled playback via `AudioBufferSourceNode.start(when)`, so once a client knows the host→client clock offset, it can start any chunk at the exact intended moment.

The hard problem is **clock-offset estimation**, not audio transport. Solved via a small NTP-style handshake.

## Architecture overview

```
   ┌─────────────────────────────┐
   │         HOST  (Mac)         │
   │  Node.js + TypeScript       │
   │  ─ decodes mp3/wav/flac     │
   │  ─ splits L / R / mono      │
   │  ─ schedules chunks         │
   │  ─ serves web UI + WS       │
   └──────────────┬──────────────┘
                  │ ws:// on LAN
         ┌────────┼────────┐
         ▼        ▼        ▼
      Client A  Client B  Client C     (other Macs, browser tabs)
       = Left   = Right   = mono
       Web Audio scheduled playback
```

Clients are **browser tabs** — no install, no native app. You visit `http://<host>.local:7500` on each Mac and assign it a channel in the host UI. This is the single biggest simplification; Web Audio is good enough for the 20ms target.

## Components

### 1. Host process (`host/`)
- Node.js + TypeScript.
- Decodes audio file → 44.1kHz 16-bit PCM via `ffmpeg` (spawned). Handles every format.
- Holds one **master timeline**: `position` in samples, `state` = playing/paused.
- Chunks the PCM into 100ms frames. For each connected client, sends frames for the channel that client is assigned (mono, left-only, right-only).
- Each frame on the wire: `{ seq, playAtHostNs, channel, sampleRate, pcm: Int16Array }` as a binary WebSocket message (small header + raw PCM).
- Buffers 500ms ahead of "now" — send rate matches playback rate, but each frame carries a play-time 500ms in the future of its send-time.
- Serves a tiny local web UI on the same port:
  - drag-drop a file
  - list of connected clients (by name / IP)
  - per-client channel dropdown (Left / Right / Mono / Mute)
  - play / pause / seek

### 2. Client (browser)
- Single HTML page served by the host. No build step required initially.
- On load:
  1. Opens a WebSocket to the host.
  2. Runs clock-sync handshake (below).
  3. Announces itself with a human-readable name (user-typed, or derived from `navigator.userAgent`).
  4. Creates an `AudioContext`.
- On each incoming audio frame:
  1. Decodes Int16 → Float32, copies into an `AudioBuffer`.
  2. Computes `when` via the **anchored schedule** (see below).
  3. Creates an `AudioBufferSourceNode`, calls `.start(when)`.
- Discards frames whose scheduled time is already in the past (late arrival) and logs it — main health signal.

#### Anchored playback schedule

Naively, each frame would compute `when = clock.hostNsToAudioTime(playAtHostNs)`. That re-evaluates the ClockSync fit for every frame, and because the fit is refit on every pong, consecutive frames land on slightly different lines. The sub-millisecond offset between them causes overlap/gap at every frame boundary, audible as clicks and broadband static.

Instead: pin `(anchorHostNs, anchorAudioTime)` at the first frame of each playback epoch, then schedule every subsequent frame purely by sample-delta from the anchor:

```
when = anchorAudioTime + Number(playAtHostNs - anchorHostNs) / 1e9
```

The anchor is reset (to null, forcing a fresh anchor on the next frame) on:
- WS reconnect
- Epoch change in the host's `transport` message (play / pause / seek)
- A `resync` message from the host (see Force-sync below)

The clock fit keeps running in the background so the *next* epoch starts aligned; within an epoch, frames never move.

### 3. Clock sync
Standard NTP-lite, runs on the same WebSocket as audio:
- Client sends `{type:"ping", t0: clientMonoNow}`.
- Host replies `{type:"pong", t0, t1: hostMonoNow}`.
- Client records `t2 = clientMonoNow` on receipt.
- RTT = `(t2 - t0)`; offset estimate = `t1 - (t0 + t2)/2`.
- Run 10 samples at connect, keep the sample with the **smallest RTT** (best-case path), then re-probe every 5 seconds and use a rolling min.
- Maintain one calibration point mapping host monotonic time → `AudioContext.currentTime`, so converting a `playAtHostNs` to a Web Audio `when` is a subtraction.

This alone gets us well under 20ms on a quiet LAN. Move to EWMA / Cristian's algorithm only if drift appears.

### 4. Discovery
- **v1: manual.** Host prints `Open http://<your-ip>:7500 on each Mac` on stdout. Macs on Bonjour can usually just use `http://<hostname>.local:7500`.
- **v2:** advertise via `mdns` npm package. Not MVP-critical.

### 5. Transport
- **WebSocket (TCP) for both control and audio** in MVP.
  - TCP head-of-line blocking is a theoretical risk but on a home LAN with 500ms lookahead buffer it's irrelevant.
  - Binary frames, no base64 — use `ws` lib's ArrayBuffer support.
- UDP is "more correct" but needs a native client — not worth it for the 20ms target.

### 6. Channel-splitting logic
- Host decodes to interleaved stereo.
- Per-client `channel` setting decides what is sent:
  - `left` → L channel only
  - `right` → R channel only
  - `mono` → (L+R)/2
  - `mute` → empty frames, so the client doesn't time out
- Each client plays its single-channel audio on **both** its speakers (no panning) — the pair of Macs creates the stereo effect by physical placement.

## Project layout

```
music-sync/
├── package.json
├── tsconfig.json
├── host/
│   ├── index.ts              # entrypoint: HTTP + WS server, CLI
│   ├── audio-pipeline.ts     # ffmpeg decode → PCM → chunker
│   ├── clients.ts            # connected client registry, channel assignment
│   ├── scheduler.ts          # timeline, transport play/pause/seek
│   ├── clock.ts              # monotonic now(), ping/pong handler
│   └── public/
│       ├── index.html        # host control UI
│       └── host-ui.js
├── client/
│   ├── index.html            # served at GET /client
│   ├── client.js             # WebSocket + Web Audio playback
│   └── clock.js              # offset estimator
└── design.md
```

One process. The host binary serves the client HTML, so there's literally one thing to run (`npm start`).

## Wire protocol

Two WebSocket endpoints on the host:
- `/ws` — audio + clock-sync. One connection per client.
- `/ctl` — host UI control channel. Used by `host/public/host-ui.js`.

All WS messages are JSON except audio frames, which are binary.

```ts
// /ws  server → client
type ServerMsg =
  | { type: "hello"; clientId: string }
  | { type: "pong"; t0: number; t1: number }
  | { type: "assign"; channel: "left" | "right" | "mono" | "mute" }
  | { type: "transport"; state: "playing" | "paused"; positionNs: string; hostNowNs: string; epoch: number }
  | { type: "resync" }   // host → clients: reset ClockSync + anchor, re-burst pings

// /ws  server ← client
type ClientMsg =
  | { type: "ping"; t0: number }
  | { type: "announce"; name: string }
  | { type: "late"; count: number }   // client-side running total of frames dropped for lateness

// /ctl  host-UI → server
type CtlMsg =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; positionSec: number }
  | { type: "assign"; id: string; channel: Channel }
  | { type: "rename"; id: string; name: string }
  | { type: "forceSync" }   // triggers a /ws resync broadcast + zeros framesLate counters

// /ctl  server → host-UI
//   { type: "state", transport: TransportSnapshot, clients: ClientSnapshot[] }
//   broadcast on every registry/scheduler change and once per second on a timer.

// binary audio frame (one ArrayBuffer)
// header: 32 bytes, little-endian
//   u32 magic = 0xAUD10FRM
//   u32 seq
//   u32 sampleRate     (e.g. 44100)
//   u32 numSamples     (per channel, e.g. 4410 for 100ms)
//   u8  channels       (always 1 after split)
//   u8  bitsPerSample  (16)
//   u16 reserved
//   i64 playAtHostNs
// body: numSamples * channels * bytesPerSample  (Int16 LE)
```

## Critical files

- `host/scheduler.ts` — the core of the app. Owns the timeline, pushes frames to all client queues at the right rate, and is the ONE place where "what time is it and what sample comes next" lives.
- `host/audio-pipeline.ts` — ffmpeg spawn + chunker.
- `host/index.ts` — HTTP + two WS servers (`/ws`, `/ctl`), upload endpoint, verbose structured logs.
- `host/public/index.html`, `host/public/host-ui.js` — host control UI. Renders connected-clients table with in-place diffing so open `<select>`s aren't blown away by 1 Hz state broadcasts.
- `client/client.js` — Web Audio scheduling + offset math + anchor. Trickiest client-side code.
- `client/clock.js` — offset estimator. Kept tiny and unit-testable.

## Host UI notes

- Drop zone is a `<label>` wrapping the file input. Do NOT add a `click` handler that also calls `fileInput.click()` — it causes the picker to open twice.
- The clients table is updated via surgical DOM edits (`syncClientsTable` in `host-ui.js`), not `innerHTML`, so an open `<select>` or focused `<input>` isn't clobbered every second. Any code that writes to those form elements must skip the write when the element is `document.activeElement`.
- **Force sync** button on the host sends `{type:"forceSync"}` on `/ctl`. The server rebroadcasts `{type:"resync"}` on every `/ws` and zeros every client's `framesLate`. Use this when audio drifts or when a client has been asleep.
- **Late** column = `framesLate` = client-reported count of frames that arrived after `ctx.currentTime + SCHEDULE_SAFETY_SEC` (20 ms). 0 means healthy; rising = network lag or clock drift.

## Milestones

1. **M1 — one client, mono, file playback works.** One Mac host, one Mac client browser, drag-in an mp3, hear it. Verify transport.
2. **M2 — clock sync + scheduled playback.** Measure skew with a second laptop by recording both speakers with a phone mic and inspecting the waveform. Target: peaks align within ~20ms.
3. **M3 — channel assignment UI + stereo.** Two Macs as L/R, physically spaced, sanity-check stereo image on a familiar track (e.g., Pink Floyd "Money").
4. **M4 — transport controls.** Play/pause/seek propagate correctly (seeking flushes client buffers and re-schedules from the new position).
5. **M5 — stability.** Reconnect on WS drop, survive laptop sleep on a client, graceful degradation when one client lags.
6. **M6+ — YouTube ingest.** `yt-dlp` as a source feeding the same `audio-pipeline.ts`. Design stays unchanged.

## Verification

- **Functional:** `npm start` on host Mac, open `http://<host>.local:7500/client` on another Mac, load a file, assign channels, hit play → audio comes out of both.
- **Sync quality:** place both Macs ~30cm apart. Record with phone voice-memo. Open the wav in Audacity, look at transient alignment on a percussive track. Expect <20ms skew; >50ms means something is wrong with clock sync.
- **Stress:** add a third client, rapidly reassign channels, seek repeatedly. No audible glitching for >60s.
- **Late-frame telemetry:** client logs `framesLate` count; host UI shows it. Should be 0 on a quiet network.

## Non-goals for MVP

- YouTube / web URL ingest (M6).
- Phone clients (Web Audio on iOS Safari has suspend-on-lock issues).
- Internet/WAN sync (needs a relay server).
- Surround (>2 channels).
- DRM'd streaming services (Spotify Connect etc.).
- Per-client volume / delay trim.
