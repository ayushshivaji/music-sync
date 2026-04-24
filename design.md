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
- Decodes audio file → **48 kHz master** 16-bit stereo PCM via `ffmpeg` (spawned). On demand, re-invokes ffmpeg to produce additional copies of the track at every distinct client sample rate (e.g. 44.1 kHz) and caches them.
- Holds one **master timeline**: `position` in master-rate samples, `state` = playing/paused. Positions stay in master samples regardless of the per-client PCM rate.
- Chunks the PCM into 100ms frames. For each connected client, sends frames for the channel that client is assigned (mono, left-only, right-only), extracted from the cached copy that matches **that client's** `AudioContext.sampleRate`. Frame length in samples therefore varies per client; frame duration stays exactly 100 ms.
- Each frame on the wire: `{ seq, playAtHostNs, channel, sampleRate, pcm: Int16Array }` as a binary WebSocket message (small header + raw PCM).
- Buffers 500ms ahead of "now" — send rate matches playback rate, but each frame carries a play-time 500ms in the future of its send-time.
- Serves a tiny local web UI on the same port:
  - drag-drop files **or a folder** (recursed; non-audio entries skipped; sorted by filename) — each upload is **appended to a FIFO queue**. The first upload becomes the current track (paused); subsequent uploads queue behind it and auto-advance when the current one ends. Folder pick also available via an "Add folder…" button that uses `<input webkitdirectory>`.
  - **URL ingest** via `/upload-url` (POST `{url, playlistLimit?}`): host spawns `yt-dlp` (packaged in the Docker image alongside ffmpeg), downloads the best audio stream, transcodes to mp3, then runs the same decode → scheduler path as a regular upload. Works for YouTube and every other site yt-dlp supports. **Playlists are supported** — each track is decoded and enqueued as soon as yt-dlp finishes it, so the first track is playable while the rest are still downloading. The playlist ceiling is controlled by the `PLAYLIST_MAX` env var (default 50, hard-clamped server-side to 500); the host UI exposes a per-request override as a number input next to the URL field, preseeded from the server's default via the `/ctl` state broadcast.
  - **Favourites** — a ★ toggle next to the URL field persists the typed URL to `${DATA_DIR}/favourites.json` on the host (default `/app/data/favourites.json`, mounted as a Docker volume so it survives container restarts). Each saved favourite shows in a panel with an inline-editable name, a ▶ button that re-submits it to `/upload-url` with the current "max" setting, and an × remove. Favourites are URL-only; file uploads aren't saved because the server-side file is ephemeral.
  - list of connected clients (by name / IP)
  - per-client **channel** dropdown (Left / Right / Mono / Mute)
  - per-client **volume** slider (0–100 %) applied client-side via a shared `GainNode` — does not rescale PCM or affect any other client
  - play / pause / seek / **next** (skip to queued track) / **clear queue** / **force sync**

### 2. Client (browser)
- Single HTML page served by the host. No build step required initially.
- On load:
  1. Creates an `AudioContext`.
  2. Opens a WebSocket to the host.
  3. Runs clock-sync handshake (below).
  4. Announces itself with a human-readable name (user-typed, or derived from `navigator.userAgent`) **and its `AudioContext.sampleRate`**. The host uses the rate to pick the right cached PCM copy so every frame arrives at the client's native rate and Web Audio does zero per-buffer resampling (which would otherwise produce polyphase-edge hiss at every 100 ms boundary).
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
  | { type: "volume"; volume: number }   // host → single client; 0..1 linear gain

// /ws  server ← client
type ClientMsg =
  | { type: "ping"; t0: number }
  | { type: "announce"; name: string; sampleRate: number }   // sampleRate = AudioContext.sampleRate
  | { type: "late"; count: number }   // client-side running total of frames dropped for lateness

// /ctl  host-UI → server
type CtlMsg =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; positionSec: number }
  | { type: "next" }                               // skip to head of queue
  | { type: "removeQueued"; index: number }        // drop a pending queue item
  | { type: "moveQueued"; fromIndex: number; toIndex: number }  // reorder within the queue
  | { type: "clearQueue" }                         // drop every pending queue item (current stays)
  | { type: "assign"; id: string; channel: Channel }
  | { type: "setVolume"; id: string; volume: number }
  | { type: "rename"; id: string; name: string }
  | { type: "addFavourite"; url: string; name?: string }
  | { type: "renameFavourite"; id: string; name: string }
  | { type: "removeFavourite"; id: string }
  | { type: "forceSync" }   // triggers a /ws resync broadcast + zeros framesLate counters

// /ctl  server → host-UI
//   { type: "state", transport: TransportSnapshot, config: ConfigSnapshot, favourites: FavouriteSnapshot[], clients: ClientSnapshot[] }
//   TransportSnapshot: { state, trackName, durationSec, positionSec, queue: Array<{name, durationSec}> }
//   ConfigSnapshot:    { playlistDefault: number, playlistCeiling: number }   // host-UI initial values / clamp
//   FavouriteSnapshot: { id, url, name }                                       // ordered newest-first
//   ClientSnapshot:    { id, name, channel, remoteAddr, framesLate, sampleRate, volume }
//   broadcast on every registry/scheduler/favourites change and once per second on a timer.

// binary audio frame (one ArrayBuffer)
// header: 32 bytes, little-endian
//   u32 magic = 0x53594e43 ("SYNC")
//   u32 seq
//   u32 sampleRate     (matches receiving client's AudioContext.sampleRate)
//   u32 numSamples     (per channel; 100ms at that rate, e.g. 4800 @ 48 kHz, 4410 @ 44.1 kHz)
//   u8  channels       (always 1 after split)
//   u8  bitsPerSample  (16)
//   u16 reserved
//   i64 playAtHostNs   (host monotonic time; same value for the same song position across all clients, regardless of each client's PCM rate — this is what keeps them synced)
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
6. **M6 — URL ingest.** `yt-dlp` as a source feeding the same `audio-pipeline.ts`. Done: `/upload-url` endpoint downloads audio via `yt-dlp -x --audio-format mp3` and enqueues it.

## Verification

- **Functional:** `npm start` on host Mac, open `http://<host>.local:7500/client` on another Mac, load a file, assign channels, hit play → audio comes out of both.
- **Sync quality:** place both Macs ~30cm apart. Record with phone voice-memo. Open the wav in Audacity, look at transient alignment on a percussive track. Expect <20ms skew; >50ms means something is wrong with clock sync.
- **Stress:** add a third client, rapidly reassign channels, seek repeatedly. No audible glitching for >60s.
- **Late-frame telemetry:** client logs `framesLate` count; host UI shows it. Should be 0 on a quiet network.

## Non-goals for MVP

- Phone clients (Web Audio on iOS Safari has suspend-on-lock issues).
- Internet/WAN sync (needs a relay server).
- Surround (>2 channels).
- DRM'd streaming services (Spotify Connect etc.).
- Per-client volume / delay trim.
