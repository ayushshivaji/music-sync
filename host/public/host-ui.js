const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const trackName = $("track-name");
const playBtn = $("play");
const pauseBtn = $("pause");
const progress = $("progress");
const timeEl = $("time");
const clientsBody = $("clients").querySelector("tbody");
const emptyEl = $("empty");
const errEl = $("err");

let ws = null;
let lastState = null;

function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ctl`);
  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "state") render(msg);
  });
  ws.addEventListener("close", () => {
    setTimeout(connect, 500);
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function render(msg) {
  lastState = msg;
  const t = msg.transport;
  trackName.textContent = t.trackName
    ? `Loaded: ${t.trackName}  (${fmtTime(t.durationSec)})`
    : "No track loaded";
  const pct = t.durationSec > 0 ? t.positionSec / t.durationSec : 0;
  progress.value = pct;
  timeEl.textContent = `${fmtTime(t.positionSec)} / ${fmtTime(t.durationSec)}`;
  playBtn.disabled = !t.trackName || t.state === "playing";
  pauseBtn.disabled = !t.trackName || t.state !== "playing";

  const rows = msg.clients.map((c) => {
    const channels = ["left", "right", "mono", "mute"];
    const opts = channels.map((ch) => `<option value="${ch}"${ch === c.channel ? " selected" : ""}>${ch}</option>`).join("");
    return `<tr>
      <td><input type="text" data-id="${c.id}" class="rename" value="${escapeHtml(c.name)}" /></td>
      <td><select data-id="${c.id}" class="assign">${opts}</select></td>
      <td class="pos">${escapeHtml(c.remoteAddr)}</td>
      <td class="pos">${c.framesLate}</td>
    </tr>`;
  });
  clientsBody.innerHTML = rows.join("");
  emptyEl.style.display = msg.clients.length ? "none" : "";
  for (const el of clientsBody.querySelectorAll("select.assign")) {
    el.addEventListener("change", () => send({ type: "assign", id: el.dataset.id, channel: el.value }));
  }
  for (const el of clientsBody.querySelectorAll("input.rename")) {
    el.addEventListener("change", () => send({ type: "rename", id: el.dataset.id, name: el.value }));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function uploadFile(file) {
  errEl.textContent = "";
  trackName.textContent = `Decoding ${file.name}…`;
  try {
    const res = await fetch("/upload", {
      method: "POST",
      headers: { "x-file-name": file.name, "content-type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const txt = await res.text();
      errEl.textContent = txt;
      return;
    }
  } catch (e) {
    errEl.textContent = String(e);
  }
}

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]);
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadFile(f);
});

playBtn.addEventListener("click", () => send({ type: "play" }));
pauseBtn.addEventListener("click", () => send({ type: "pause" }));
progress.addEventListener("click", (e) => {
  if (!lastState?.transport.durationSec) return;
  const rect = progress.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  send({ type: "seek", positionSec: Math.max(0, Math.min(1, frac)) * lastState.transport.durationSec });
});

connect();
