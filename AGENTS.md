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
- **Track queue.** Uploads append to a FIFO queue on the scheduler (`enqueue` in `host/scheduler.ts`), not replace the current track. The first upload becomes the current track paused at 0; subsequent uploads wait behind it. `tick()` auto-calls `advance(true)` at end-of-track when the queue is non-empty (seamlessly loads + plays next, bumping epoch so clients re-anchor). `skipNext` ignores the call if queue is empty. Reorder via `moveQueued(fromIndex, toIndex)` — host-UI exposes this via HTML5 drag-and-drop on queue rows; the UI computes the post-splice `toIndex` before sending (i.e. it accounts for the `from` item being removed first, so the server just splices from → splices into `toIndex`). Don't revive the single-track `loadTrack` path on `/upload` — it wipes the queue.
- **Bulk / folder upload.** The UI accepts multi-file picks (`<input type="file" multiple>`), a folder pick (`<input webkitdirectory>`), and dropped folders (traversed via `DataTransferItem.webkitGetAsEntry()` → FileSystem API). All flow through `uploadMany` in `host/public/host-ui.js`, which filters by `AUDIO_EXT_RE`, sorts with `localeCompare(… numeric:true)`, then POSTs to `/upload` **sequentially** — the host ffmpeg-decodes one upload at a time, and sequential posts preserve queue order. Do not parallelise uploads without also serialising them server-side; concurrent ffmpeg spawns can race on the scheduler's per-rate cache.
- **URL ingest.** `POST /upload-url` with JSON `{url, playlistLimit?}` runs `yt-dlp -x --audio-format mp3` into `UPLOAD_DIR`, captures each completed track's path via `--print after_move:filepath`, and passes it one-by-one to an `onTrack` callback that decodes + `scheduler.enqueue`s — so the first track of a playlist is playable while the rest are still downloading. Logic lives in `host/url-fetch.ts::fetchAudioFromUrl` (readline over the child's stdout, serialized `onTrack` promise chain to preserve queue order); endpoint in `host/index.ts::handleUrlUpload`. Dockerfile adds `yt-dlp` via `apk add`. **Playlists:** `--playlist-end <limit> --ignore-errors` with `limit` coming from the request, falling back to the `PLAYLIST_MAX` env var (default 50) and hard-clamped server-side to 500. The `/ctl` state broadcast carries `config.playlistDefault` + `config.playlistCeiling` so the host UI's number input preseeds from the server instead of a hardcoded constant. Other defaults: `--max-filesize 500M --socket-timeout 30 -q`. If you ever expose this to a LAN beyond your own devices, add URL allow-listing — yt-dlp supports file:// and can be weaponised.
- **Favourites.** URL-only persistent shortlist. Lives in `${DATA_DIR}/favourites.json` (default `./data/favourites.json`, Docker sets `DATA_DIR=/app/data` with a named volume so it survives restarts). `host/favourites.ts::FavouritesStore` owns in-memory state + atomic save (tempfile + rename, serialized via a promise chain so concurrent mutations can't interleave). Mutations come via `/ctl` messages: `addFavourite {url, name?}` (dedupes by URL so the UI ★ toggle is idempotent), `renameFavourite {id, name}`, `removeFavourite {id}`. State broadcast carries `favourites: Array<{id, url, name}>` (ordered newest-first; `addedAt` is not exposed because the UI doesn't use it). Playing a favourite reuses `/upload-url` with the stored URL + the UI's current "max" — no special playback path.
- **Per-client volume.** Each `AudioClient` has a linear `volume ∈ [0, 1]` (default 1). Host UI sends `{type:"setVolume", id, volume}` on `/ctl`; server updates the registry and forwards `{type:"volume", volume}` on that client's `/ws`. The client applies it via a single shared `GainNode` between all `AudioBufferSourceNode`s and `ctx.destination`. Changes use `setTargetAtTime` with a ~10 ms smoothing constant to avoid a click. Do not scale PCM on the host — that would force per-client resamples and defeat the rate-negotiation work.
- **Per-client sample rates.** `host/clock.ts` defines a master rate (`SAMPLE_RATE = 48000`) used for all timeline math (`playAtHostNs`, seek, positions). Each client declares its own `AudioContext.sampleRate` in `announce`; the scheduler serves that client from a rate-matched cached copy of the track (populated on demand via ffmpeg in `resampleTrackTo`). Frame *duration* is fixed at 100 ms; frame *sample count* is therefore per-client. The client trusts the per-frame header `sampleRate` when creating its `AudioBuffer`, so Web Audio never resamples. Do not reintroduce a single global frame-sample constant on the client side.
- **Other fixed constants:** `LOOKAHEAD_NS = 500 ms`, `TICK_MS = 50` in `host/scheduler.ts`.
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
