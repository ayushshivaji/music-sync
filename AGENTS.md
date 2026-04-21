# AGENTS.md

Read **[`design.md`](./design.md)** first. It is the canonical reference for the project's architecture, wire protocol, critical files, and design decisions. Anything below is a quick orientation; `design.md` is the source of truth.

## What this project is

`music-sync` turns multiple Macs on the same LAN into a coordinated speaker array. One host Mac decodes an audio file with ffmpeg and streams PCM frames over WebSocket to browser-tab clients running the Web Audio API. Clients use NTP-style clock sync to schedule playback at a common wall-clock moment, so the speakers stay aligned.

## Repo layout (abridged — full detail in `design.md`)

```
host/               Node + TypeScript server. Decoding, scheduling, WS endpoints.
  index.ts            HTTP + /ws (audio) + /ctl (host UI) + /upload
  audio-pipeline.ts   ffmpeg spawn → Int16 PCM
  scheduler.ts        master timeline, 100 ms frames, 500 ms lookahead
  clients.ts          connected-client registry
  clock.ts            nowNs() + binary frame codec
  public/             host UI (index.html + host-ui.js)
client/             Browser client. Served by the host at /client.
  client.js           WS + anchored Web Audio scheduling
  clock.js            weighted LSQ clock-sync fit
design.md           architecture, wire protocol, non-goals, milestones
Dockerfile, docker-compose.yml   containerised host (alpine + ffmpeg)
```

## Conventions that aren't obvious from the code

- **Read `design.md` before making architectural changes.** When the architecture changes (new wire-protocol messages, new sync strategy, new transport), update `design.md` in the same PR so this document stays the source of truth.
- **Server-side logs are the debugging surface for Docker users.** `host/index.ts` exposes `log(tag, msg, extra)` / `logErr(...)` helpers that emit timestamped, JSON-suffixed lines to stdout. Use them for every meaningful upload / decode / WS lifecycle event — the user inspects these with `docker compose logs`.
- **Host UI renders are in-place.** `syncClientsTable` in `host-ui.js` diffs the clients table rather than rebuilding `innerHTML`. Never write to a `<select>` or `<input>` that is `document.activeElement`, or you'll close the user's open dropdown / kill their keystroke.
- **Anchored playback scheduling.** Do not re-evaluate `clock.hostNsToAudioTime` for every frame — that caused audible static. Once an anchor `(anchorHostNs, anchorAudioTime)` is set for an epoch, schedule later frames as `anchorAudioTime + (playAtHostNs − anchorHostNs) / 1e9`. Anchor resets on WS reconnect, epoch change in `transport`, or `resync`. Details in `design.md` → Client section.
- **Frame size, lookahead, sample rate are fixed constants** in `host/clock.ts` (`SAMPLE_RATE = 44100`, `FRAME_SAMPLES = 4410` = 100 ms) and `host/scheduler.ts` (`LOOKAHEAD_NS = 500 ms`, `TICK_MS = 50`). Client mirrors these via header fields, not hardcoded constants.
- **Docker.** `docker compose up --build`. Ports: `7500:7500`. On Docker Desktop (Mac/Windows) every client shows up with the same bridge-gateway IP — that's expected, not a bug. Linux can use `network_mode: host` instead.

## Where to look for common tasks

- "Change how audio is decoded / chunked" → `host/audio-pipeline.ts`, `host/scheduler.ts`.
- "Change the wire protocol" → update `host/clock.ts` (`encodeFrame`), the `/ws` handlers in `host/index.ts`, the binary parser in `client/client.js`, **and** the Wire protocol section of `design.md`.
- "Change the host UI" → `host/public/index.html` + `host/public/host-ui.js`. Preserve the in-place diff pattern.
- "Change clock-sync strategy" → `client/clock.js` (fit) and the anchor logic in `client/client.js`.
- "Change Docker packaging" → `Dockerfile`, `docker-compose.yml`, `.dockerignore`.

## Non-goals (copy of `design.md` — do not propose these without asking)

- YouTube / web URL ingest (M6).
- Phone clients.
- Internet/WAN sync.
- Surround > 2 channels.
- DRM streaming services.
- Per-client volume / delay trim.
