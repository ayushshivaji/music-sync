const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const folderInput = $("folder");
const pickFolderBtn = $("pick-folder");
const urlInput = $("url-input");
const urlSubmitBtn = $("url-submit");
const urlMaxInput = $("url-max");
const urlFavBtn = $("url-fav");
const favWrap = $("fav-wrap");
const favList = $("favs");

let playlistDefaultApplied = false;
let playlistCeiling = 500;
let currentFavourites = [];
const trackName = $("track-name");
const trackFavBtn = $("track-fav");
const playBtn = $("play");
const pauseBtn = $("pause");
const nextBtn = $("next");
const forceSyncBtn = $("force-sync");
const progress = $("progress");
const timeEl = $("time");
const clientsBody = $("clients").querySelector("tbody");
const emptyEl = $("empty");
const errEl = $("err");
const queueWrap = $("queue-wrap");
const queueList = $("queue");
const clearQueueBtn = $("clear-queue");

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
  if (msg.config) {
    if (Number.isFinite(msg.config.playlistCeiling)) {
      playlistCeiling = msg.config.playlistCeiling;
      urlMaxInput.max = String(playlistCeiling);
    }
    if (!playlistDefaultApplied && Number.isFinite(msg.config.playlistDefault)) {
      urlMaxInput.value = String(msg.config.playlistDefault);
      playlistDefaultApplied = true;
    }
  }
  const t = msg.transport;
  trackName.textContent = t.trackName
    ? `Loaded: ${t.trackName}  (${fmtTime(t.durationSec)})`
    : "No track loaded";
  const pct = t.durationSec > 0 ? t.positionSec / t.durationSec : 0;
  progress.value = pct;
  timeEl.textContent = `${fmtTime(t.positionSec)} / ${fmtTime(t.durationSec)}`;
  playBtn.disabled = !t.trackName || t.state === "playing";
  pauseBtn.disabled = !t.trackName || t.state !== "playing";
  const queue = t.queue ?? [];
  nextBtn.disabled = queue.length === 0;

  renderQueue(queue);
  renderFavourites(msg.favourites ?? []);
  syncClientsTable(msg.clients);
  emptyEl.style.display = msg.clients.length ? "none" : "";
}

function renderFavourites(favs) {
  currentFavourites = favs;
  if (favs.length === 0) {
    favWrap.style.display = "none";
    favList.innerHTML = "";
  } else {
    favWrap.style.display = "";
    const needed = favs.length;
    while (favList.children.length < needed) favList.appendChild(buildFavLi());
    while (favList.children.length > needed) favList.removeChild(favList.lastChild);
    for (let i = 0; i < needed; i++) {
      const li = favList.children[i];
      const f = favs[i];
      li.dataset.id = f.id;
      const nameInput = li.querySelector("input.fav-name");
      const urlSpan = li.querySelector(".fav-url");
      if (document.activeElement !== nameInput && nameInput.value !== f.name) {
        nameInput.value = f.name;
      }
      if (urlSpan.textContent !== f.url) {
        urlSpan.textContent = f.url;
        urlSpan.title = f.url;
      }
    }
  }
  updateStarButton();
}

function buildFavLi() {
  const li = document.createElement("li");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "fav-name";
  nameInput.title = "Display name (click to rename)";
  nameInput.addEventListener("change", () => {
    send({ type: "renameFavourite", id: li.dataset.id, name: nameInput.value });
  });
  const urlSpan = document.createElement("span");
  urlSpan.className = "fav-url pos";
  const playBtn = document.createElement("button");
  playBtn.textContent = "▶";
  playBtn.title = "Queue this favourite";
  playBtn.addEventListener("click", async () => {
    const fav = currentFavourites.find((f) => f.id === li.dataset.id);
    if (!fav) return;
    await submitUrlValue(fav.url);
  });
  const removeBtn = document.createElement("button");
  removeBtn.textContent = "×";
  removeBtn.title = "Remove from favourites";
  removeBtn.addEventListener("click", () => {
    send({ type: "removeFavourite", id: li.dataset.id });
  });
  li.append(nameInput, urlSpan, playBtn, removeBtn);
  return li;
}

function updateStarButton() {
  const url = (urlInput.value || "").trim();
  const starred = !!url && currentFavourites.some((f) => f.url === url);
  urlFavBtn.textContent = starred ? "★" : "☆";
  urlFavBtn.title = starred
    ? "Already in favourites."
    : "Save this URL to favourites (persisted on the host). Does not play it.";
  urlFavBtn.disabled = !url;
}

function renderQueue(queue) {
  if (queue.length === 0) {
    queueWrap.style.display = "none";
    queueList.innerHTML = "";
    return;
  }
  queueWrap.style.display = "";
  const needed = queue.length;
  while (queueList.children.length < needed) queueList.appendChild(buildQueueLi());
  while (queueList.children.length > needed) queueList.removeChild(queueList.lastChild);
  for (let i = 0; i < needed; i++) {
    const li = queueList.children[i];
    const q = queue[i];
    li.dataset.index = String(i);
    const label = `${q.name}  (${fmtTime(q.durationSec)})`;
    const nameSpan = li.querySelector(".qname");
    if (nameSpan.textContent !== label) nameSpan.textContent = label;
  }
}

function buildQueueLi() {
  const li = document.createElement("li");
  li.draggable = true;
  li.title = "Drag to reorder";

  const handle = document.createElement("span");
  handle.className = "handle";
  handle.textContent = "⋮⋮";
  handle.setAttribute("aria-hidden", "true");

  const nameSpan = document.createElement("span");
  nameSpan.className = "qname pos";

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove from queue";
  // Don't let a remove click initiate a drag.
  removeBtn.draggable = false;
  removeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  removeBtn.addEventListener("click", () => {
    const idx = Number(li.dataset.index);
    send({ type: "removeQueued", index: idx });
  });

  li.append(handle, nameSpan, removeBtn);
  attachDragHandlers(li);
  return li;
}

function clearDropMarkers() {
  for (const li of queueList.children) {
    li.classList.remove("drop-before", "drop-after", "dragging");
  }
}

function attachDragHandlers(li) {
  li.addEventListener("dragstart", (e) => {
    const idx = li.dataset.index;
    if (idx === undefined) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-queue-index", idx);
    // Fallback for browsers that ignore custom types.
    e.dataTransfer.setData("text/plain", idx);
    li.classList.add("dragging");
  });

  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = li.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    for (const other of queueList.children) {
      if (other !== li) other.classList.remove("drop-before", "drop-after");
    }
    li.classList.toggle("drop-before", before);
    li.classList.toggle("drop-after", !before);
  });

  li.addEventListener("dragleave", () => {
    li.classList.remove("drop-before", "drop-after");
  });

  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const raw =
      e.dataTransfer.getData("text/x-queue-index") ||
      e.dataTransfer.getData("text/plain");
    clearDropMarkers();
    const fromIndex = Number(raw);
    const targetIndex = Number(li.dataset.index);
    if (!Number.isFinite(fromIndex) || !Number.isFinite(targetIndex)) return;
    if (fromIndex === targetIndex) return;
    const rect = li.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    // Desired insertion index in the ORIGINAL list (before the splice-out).
    let toIndex = before ? targetIndex : targetIndex + 1;
    // Removing the from-index shifts everything after it up by 1, so adjust.
    if (fromIndex < toIndex) toIndex -= 1;
    if (fromIndex === toIndex) return;
    send({ type: "moveQueued", fromIndex, toIndex });
  });

  li.addEventListener("dragend", clearDropMarkers);
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

  const volTd = document.createElement("td");
  volTd.style.display = "flex";
  volTd.style.alignItems = "center";
  volTd.style.gap = ".4rem";
  const volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.className = "volume";
  volSlider.min = "0";
  volSlider.max = "1";
  volSlider.step = "0.01";
  volSlider.value = String(c.volume ?? 1);
  volSlider.style.flex = "1";
  volSlider.dataset.id = c.id;
  const volLabel = document.createElement("span");
  volLabel.className = "vol-label pos";
  volLabel.style.minWidth = "2.5em";
  volLabel.style.textAlign = "right";
  volLabel.textContent = `${Math.round((c.volume ?? 1) * 100)}`;
  const sendVolume = () => {
    volLabel.textContent = `${Math.round(Number(volSlider.value) * 100)}`;
    send({ type: "setVolume", id: volSlider.dataset.id, volume: Number(volSlider.value) });
  };
  volSlider.addEventListener("input", sendVolume);
  volTd.append(volSlider, volLabel);

  const addrTd = document.createElement("td");
  addrTd.className = "pos";
  addrTd.textContent = c.remoteAddr;

  const lateTd = document.createElement("td");
  lateTd.className = "pos";
  lateTd.textContent = String(c.framesLate);

  tr.append(nameTd, chanTd, volTd, addrTd, lateTd);
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
    const volSlider = tr.querySelector("input.volume");
    const volLabel = tr.querySelector("span.vol-label");
    const addrTd = tr.children[3];
    const lateTd = tr.children[4];
    if (document.activeElement !== nameInput && nameInput.value !== c.name) {
      nameInput.value = c.name;
    }
    if (document.activeElement !== select && select.value !== c.channel) {
      select.value = c.channel;
    }
    const incomingVol = c.volume ?? 1;
    if (document.activeElement !== volSlider && Math.abs(Number(volSlider.value) - incomingVol) > 0.005) {
      volSlider.value = String(incomingVol);
      volLabel.textContent = `${Math.round(incomingVol * 100)}`;
    }
    if (addrTd.textContent !== c.remoteAddr) addrTd.textContent = c.remoteAddr;
    const lateStr = String(c.framesLate);
    if (lateTd.textContent !== lateStr) lateTd.textContent = lateStr;
  }
}

const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|mp4|ogg|oga|opus|aac|wma|aif|aiff)$/i;

async function uploadFile(file) {
  try {
    const res = await fetch("/upload", {
      method: "POST",
      headers: { "x-file-name": file.name, "content-type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: txt };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function uploadMany(files) {
  errEl.textContent = "";
  const audio = files.filter((f) => AUDIO_EXT_RE.test(f.name));
  audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (audio.length === 0) {
    errEl.textContent = "No audio files in selection.";
    return;
  }
  const errors = [];
  for (let i = 0; i < audio.length; i++) {
    const f = audio[i];
    trackName.textContent = `Uploading ${i + 1}/${audio.length}: ${f.name}…`;
    const result = await uploadFile(f);
    if (!result.ok) errors.push(`${f.name}: ${result.error}`);
  }
  if (errors.length > 0) {
    errEl.textContent = `${errors.length} of ${audio.length} uploads failed:\n${errors.join("\n")}`;
  }
}

// Walk a DataTransfer's items, recursing into dropped directories via the
// webkit FileSystem API. Returns a flat File[].
async function filesFromDrop(dt) {
  if (!dt.items || typeof dt.items[0]?.webkitGetAsEntry !== "function") {
    return Array.from(dt.files ?? []);
  }
  const out = [];
  const roots = [];
  for (const item of dt.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) roots.push(entry);
    else {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  await Promise.all(roots.map((e) => walkEntry(e, out)));
  return out;
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readAllEntries(reader);
    await Promise.all(entries.map((e) => walkEntry(e, out)));
  }
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          step();
        }
      }, reject);
    };
    step();
  });
}

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length === 0) return;
  await uploadMany(files);
  fileInput.value = "";
});
pickFolderBtn.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", async () => {
  const files = Array.from(folderInput.files ?? []);
  if (files.length === 0) return;
  await uploadMany(files);
  folderInput.value = "";
});

async function submitUrlValue(url, { clearInput = false } = {}) {
  if (!url) return;
  if (urlSubmitBtn.disabled) return;
  const rawLimit = Number(urlMaxInput.value);
  const playlistLimit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(playlistCeiling, Math.floor(rawLimit)))
    : undefined;
  errEl.textContent = "";
  const original = urlSubmitBtn.textContent;
  urlSubmitBtn.disabled = true;
  urlSubmitBtn.textContent = "Fetching…";
  try {
    const res = await fetch("/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, playlistLimit }),
    });
    if (!res.ok) {
      errEl.textContent = `URL fetch failed: ${await res.text()}`;
    } else {
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      if (clearInput) urlInput.value = "";
      if (body && typeof body.count === "number" && typeof body.failed === "number") {
        if (body.failed > 0) {
          errEl.textContent = `Queued ${body.count} track${body.count === 1 ? "" : "s"}; ${body.failed} failed.`;
        }
      }
      updateStarButton();
    }
  } catch (e) {
    errEl.textContent = `URL fetch failed: ${e}`;
  } finally {
    urlSubmitBtn.disabled = false;
    urlSubmitBtn.textContent = original;
  }
}

function submitUrlFromInput() {
  const url = urlInput.value.trim();
  return submitUrlValue(url, { clearInput: true });
}
urlSubmitBtn.addEventListener("click", submitUrlFromInput);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitUrlFromInput(); }
});
urlInput.addEventListener("input", updateStarButton);
urlFavBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  const existing = currentFavourites.find((f) => f.url === url);
  if (existing) {
    // Toggle off — acts as a quick-remove shortcut.
    send({ type: "removeFavourite", id: existing.id });
  } else {
    send({ type: "addFavourite", url });
  }
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  if (!e.dataTransfer) return;
  const files = await filesFromDrop(e.dataTransfer);
  if (files.length > 0) await uploadMany(files);
});

playBtn.addEventListener("click", () => send({ type: "play" }));
pauseBtn.addEventListener("click", () => send({ type: "pause" }));
nextBtn.addEventListener("click", () => send({ type: "next" }));
clearQueueBtn.addEventListener("click", () => send({ type: "clearQueue" }));
forceSyncBtn.addEventListener("click", () => send({ type: "forceSync" }));
progress.addEventListener("click", (e) => {
  if (!lastState?.transport.durationSec) return;
  const rect = progress.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  send({ type: "seek", positionSec: Math.max(0, Math.min(1, frac)) * lastState.transport.durationSec });
});

connect();
