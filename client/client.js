import { ClockSync } from "./clock.js";

const FRAME_MAGIC = 0x53594e43;
const HEADER_BYTES = 32;
const SCHEDULE_SAFETY_SEC = 0.02;

const $ = (id) => document.getElementById(id);

const nameInput = $("name");
const joinBtn = $("join");
const joinCard = $("join-card");
const statusCard = $("status-card");
const statusEl = $("status");
const dotEl = $("dot");
const channelEl = $("channel");
const rttEl = $("rtt");
const driftEl = $("drift");
const residualEl = $("residual");
const samplesEl = $("samples");
const lateEl = $("late");
const sampleRateEl = $("sample-rate");

nameInput.value = guessName();

function guessName() {
  const ua = navigator.userAgent;
  if (ua.includes("Macintosh")) return `mac-${Math.random().toString(36).slice(2, 5)}`;
  return `client-${Math.random().toString(36).slice(2, 5)}`;
}

joinBtn.addEventListener("click", start);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });

let ctx = null;
let gain = null;
let ws = null;
let clock = null;
let channel = "mono";
let framesLate = 0;
let framesPlayed = 0;
let pingTimer = null;
let currentEpoch = 0;
let scheduledNodes = [];
let anchorHostNs = null;
let anchorAudioTime = null;

function resetAnchor() {
  anchorHostNs = null;
  anchorAudioTime = null;
}

function pingBurst() {
  for (let i = 0; i < 10; i++) setTimeout(ping, i * 40);
}

async function start() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
  if (ctx.state === "suspended") await ctx.resume();
  gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(ctx.destination);
  clock = new ClockSync(ctx);
  clock.onChange(renderStatus);
  if (sampleRateEl) sampleRateEl.textContent = `${ctx.sampleRate} Hz`;
  joinCard.style.display = "none";
  statusCard.style.display = "";
  connect();
}

function connect() {
  setStatus("connecting", "warn");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    setStatus("connected", "ok");
    send({
      type: "announce",
      name: nameInput.value || "client",
      sampleRate: ctx.sampleRate,
    });
    // Startup burst — fills the regression window quickly with low-RTT samples.
    pingBurst();
    // Then steady cadence spread over ~2 min for a clean drift slope.
    pingTimer = setInterval(ping, 3000);
  });
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") handleJson(JSON.parse(e.data));
    else handleBinary(e.data);
  });
  ws.addEventListener("close", () => {
    setStatus("reconnecting", "warn");
    clearInterval(pingTimer);
    cancelScheduled();
    resetAnchor();
    clock.reset();
    setTimeout(connect, 500);
  });
  ws.addEventListener("error", () => setStatus("error", "bad"));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function ping() {
  if (!clock) return;
  const t0 = clock.nowNs();
  send({ type: "ping", t0: Number(t0) });
}

function handleJson(msg) {
  if (msg.type === "hello") {
    // clientId available in msg.clientId; not currently displayed
  } else if (msg.type === "pong") {
    clock.handlePong(msg.t0, msg.t1);
  } else if (msg.type === "assign") {
    channel = msg.channel;
    renderStatus();
  } else if (msg.type === "transport") {
    if (typeof msg.epoch === "number" && msg.epoch !== currentEpoch) {
      currentEpoch = msg.epoch;
      cancelScheduled();
      resetAnchor();
    }
    if (msg.state !== "playing") {
      cancelScheduled();
      resetAnchor();
    }
  } else if (msg.type === "resync") {
    cancelScheduled();
    resetAnchor();
    clock.reset();
    framesLate = 0;
    renderStatus();
    pingBurst();
  } else if (msg.type === "volume") {
    if (gain && typeof msg.volume === "number" && Number.isFinite(msg.volume)) {
      const vol = Math.max(0, Math.min(1, msg.volume));
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(vol, now, 0.01);
    }
  }
}

function handleBinary(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES) return;
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== FRAME_MAGIC) return;
  const sampleRate = dv.getUint32(8, true);
  const numSamples = dv.getUint32(12, true);
  const playAtHostNs = dv.getBigInt64(20, true);
  const pcm = new Int16Array(buf, HEADER_BYTES, numSamples);

  let when;
  if (anchorHostNs === null) {
    const at = clock.hostNsToAudioTime(playAtHostNs);
    if (at === null) {
      // not clock-synced yet → play immediately, inherently loose for the first few frames
      schedulePcm(pcm, sampleRate, ctx.currentTime + 0.05);
      return;
    }
    anchorHostNs = playAtHostNs;
    anchorAudioTime = at;
    when = at;
  } else {
    when = anchorAudioTime + Number(playAtHostNs - anchorHostNs) / 1e9;
  }
  const deadline = ctx.currentTime + SCHEDULE_SAFETY_SEC;
  if (when < deadline) {
    framesLate++;
    send({ type: "late", count: framesLate });
    renderStatus();
    return;
  }
  schedulePcm(pcm, sampleRate, when);
}

function schedulePcm(pcmInt16, sampleRate, when) {
  const buf = ctx.createBuffer(1, pcmInt16.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcmInt16.length; i++) ch[i] = pcmInt16[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(gain ?? ctx.destination);
  src.onended = () => {
    const idx = scheduledNodes.indexOf(src);
    if (idx >= 0) scheduledNodes.splice(idx, 1);
  };
  try {
    src.start(when);
    scheduledNodes.push(src);
    framesPlayed++;
  } catch {
    /* happens if `when` is already past; drop silently */
  }
}

function cancelScheduled() {
  for (const n of scheduledNodes) {
    try { n.stop(); } catch { /* already stopped */ }
  }
  scheduledNodes = [];
}

function setStatus(text, level) {
  statusEl.textContent = text;
  dotEl.className = `dot ${level ?? ""}`;
}

function renderStatus() {
  channelEl.textContent = channel;
  const rtt = clock?.rttMs();
  const drift = clock?.driftPpm();
  const residual = clock?.residualMsLatest();
  const n = clock?.sampleCount() ?? 0;
  rttEl.textContent = rtt === null || rtt === undefined ? "measuring…" : `${rtt.toFixed(2)} ms`;
  driftEl.textContent = drift === null || drift === undefined
    ? "—"
    : `${drift >= 0 ? "+" : ""}${drift.toFixed(1)} ppm`;
  residualEl.textContent = residual === null || residual === undefined
    ? "—"
    : `${residual.toFixed(2)} ms`;
  samplesEl.textContent = String(n);
  lateEl.textContent = String(framesLate);
}
