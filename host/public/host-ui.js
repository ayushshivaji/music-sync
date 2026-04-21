const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const trackName = $("track-name");
const playBtn = $("play");
const pauseBtn = $("pause");
const forceSyncBtn = $("force-sync");
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

  syncClientsTable(msg.clients);
  emptyEl.style.display = msg.clients.length ? "none" : "";
}

const CHANNELS = ["left", "right", "mono", "mute"];

function createClientRow(c) {
  const tr = document.createElement("tr");
  tr.dataset.cid = c.id;

  const nameTd = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "rename";
  nameInput.dataset.id = c.id;
  nameInput.value = c.name;
  nameInput.addEventListener("change", () => send({ type: "rename", id: c.id, name: nameInput.value }));
  nameTd.appendChild(nameInput);

  const chanTd = document.createElement("td");
  const select = document.createElement("select");
  select.className = "assign";
  select.dataset.id = c.id;
  for (const ch of CHANNELS) {
    const opt = document.createElement("option");
    opt.value = ch;
    opt.textContent = ch;
    if (ch === c.channel) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => send({ type: "assign", id: select.dataset.id, channel: select.value }));
  chanTd.appendChild(select);

  const addrTd = document.createElement("td");
  addrTd.className = "pos";
  addrTd.textContent = c.remoteAddr;

  const lateTd = document.createElement("td");
  lateTd.className = "pos";
  lateTd.textContent = String(c.framesLate);

  tr.append(nameTd, chanTd, addrTd, lateTd);
  return tr;
}

function syncClientsTable(clients) {
  const existing = new Map();
  for (const tr of clientsBody.querySelectorAll("tr[data-cid]")) {
    existing.set(tr.dataset.cid, tr);
  }
  const incomingIds = new Set(clients.map((c) => c.id));

  for (const [id, tr] of existing) {
    if (!incomingIds.has(id)) {
      if (!tr.contains(document.activeElement)) tr.remove();
    }
  }

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    let tr = existing.get(c.id);
    if (!tr) {
      tr = createClientRow(c);
      clientsBody.appendChild(tr);
      continue;
    }
    const nameInput = tr.querySelector("input.rename");
    const select = tr.querySelector("select.assign");
    const addrTd = tr.children[2];
    const lateTd = tr.children[3];
    if (document.activeElement !== nameInput && nameInput.value !== c.name) {
      nameInput.value = c.name;
    }
    if (document.activeElement !== select && select.value !== c.channel) {
      select.value = c.channel;
    }
    if (addrTd.textContent !== c.remoteAddr) addrTd.textContent = c.remoteAddr;
    const lateStr = String(c.framesLate);
    if (lateTd.textContent !== lateStr) lateTd.textContent = lateStr;
  }
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
forceSyncBtn.addEventListener("click", () => send({ type: "forceSync" }));
progress.addEventListener("click", (e) => {
  if (!lastState?.transport.durationSec) return;
  const rect = progress.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  send({ type: "seek", positionSec: Math.max(0, Math.min(1, frac)) * lastState.transport.durationSec });
});

connect();
