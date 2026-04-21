import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import { nowNs, type Channel } from "./clock.ts";
import { decodeFileToPcm } from "./audio-pipeline.ts";
import { ClientRegistry, mintClientId, type AudioClient } from "./clients.ts";
import { Scheduler } from "./scheduler.ts";

const PORT = Number(process.env.PORT ?? 7500);
const HOST_DIR = new URL(".", import.meta.url).pathname;
const CLIENT_DIR = join(HOST_DIR, "..", "client");
const PUBLIC_DIR = join(HOST_DIR, "public");
const UPLOAD_DIR = join(tmpdir(), "music-sync-uploads");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

function log(tag: string, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = extra ? " " + JSON.stringify(extra) : "";
  console.log(`[${ts}] [${tag}] ${msg}${suffix}`);
}
function logErr(tag: string, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = extra ? " " + JSON.stringify(extra) : "";
  console.error(`[${ts}] [${tag}] ${msg}${suffix}`);
}

async function serveStatic(
  dir: string,
  name: string,
  res: ServerResponse,
): Promise<boolean> {
  try {
    const path = join(dir, name);
    if (!path.startsWith(dir)) return false;
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const registry = new ClientRegistry();
const scheduler = new Scheduler(registry);

const controlSockets = new Set<WebSocket>();

function broadcastControl(): void {
  const msg = JSON.stringify({
    type: "state",
    transport: scheduler.snapshot(),
    clients: registry.all().map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      remoteAddr: c.remoteAddr,
      framesLate: c.framesLate,
    })),
  });
  for (const ws of controlSockets) {
    try { ws.send(msg); } catch { /* ignore */ }
  }
}

registry.onChange(broadcastControl);
scheduler.onChange(broadcastControl);

async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const remote = req.socket.remoteAddress ?? "?";
  const suggestedName = (req.headers["x-file-name"] as string | undefined) ?? `upload-${Date.now()}`;
  const safeName = basename(suggestedName).replace(/[^A-Za-z0-9._-]/g, "_");
  log("upload", "request received", { remote, suggestedName, safeName });

  await mkdir(UPLOAD_DIR, { recursive: true });
  const targetPath = join(UPLOAD_DIR, `${randomUUID()}-${safeName}`);
  const chunks: Buffer[] = [];
  let total = 0;
  const startedAt = Date.now();
  try {
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).byteLength;
      if (total > 500 * 1024 * 1024) {
        logErr("upload", "aborted — exceeds 500MB cap", { safeName, bytes: total });
        res.writeHead(413); res.end("file too large (500MB cap)"); return;
      }
    }
  } catch (err) {
    logErr("upload", "stream read error", { safeName, error: (err as Error).message });
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`upload read failed: ${(err as Error).message}`);
    return;
  }
  const readMs = Date.now() - startedAt;
  log("upload", "body fully received", { safeName, bytes: total, readMs });

  try {
    await writeFile(targetPath, Buffer.concat(chunks));
    log("upload", "written to disk", { targetPath, bytes: total });
  } catch (err) {
    logErr("upload", "failed to write file", { targetPath, error: (err as Error).message });
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`write failed: ${(err as Error).message}`);
    return;
  }

  try {
    log("decode", "invoking ffmpeg", { targetPath, displayName: safeName });
    const decodeStart = Date.now();
    const track = await decodeFileToPcm(targetPath, safeName);
    log("decode", "success", {
      name: safeName,
      durationSec: Number(track.durationSec.toFixed(3)),
      numFrames: track.numFrames,
      sampleRate: track.sampleRate,
      decodeMs: Date.now() - decodeStart,
    });
    scheduler.loadTrack(track);
    log("scheduler", "track loaded", { name: safeName, durationSec: Number(track.durationSec.toFixed(3)) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: safeName, durationSec: track.durationSec }));
  } catch (err) {
    logErr("decode", "ffmpeg failed", { name: safeName, error: (err as Error).message });
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`decode failed: ${(err as Error).message}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === "POST" && path === "/upload") {
      await handleUpload(req, res);
      return;
    }
    if (req.method === "GET") {
      log("http", `${req.method} ${path}`, { remote: req.socket.remoteAddress ?? "?" });
    }
    if (req.method === "GET" && path === "/") {
      if (await serveStatic(PUBLIC_DIR, "index.html", res)) return;
    }
    if (req.method === "GET" && path === "/host-ui.js") {
      if (await serveStatic(PUBLIC_DIR, "host-ui.js", res)) return;
    }
    if (req.method === "GET" && (path === "/client" || path === "/client/")) {
      if (await serveStatic(CLIENT_DIR, "index.html", res)) return;
    }
    if (req.method === "GET" && path.startsWith("/client/")) {
      const rel = path.slice("/client/".length);
      if (await serveStatic(CLIENT_DIR, rel, res)) return;
    }
    res.writeHead(404); res.end("not found");
  } catch (err) {
    res.writeHead(500); res.end((err as Error).message);
  }
});

const audioWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/ws") {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit("connection", ws, req));
  } else if (url.pathname === "/ctl") {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

audioWss.on("connection", (ws, req) => {
  const id = mintClientId();
  const client: AudioClient = {
    id,
    ws,
    name: `client-${id}`,
    channel: "mono",
    remoteAddr: req.socket.remoteAddress ?? "?",
    connectedAtNs: nowNs(),
    framesLate: 0,
    nextSendFrame: scheduler.snapshot().positionSec * 44100 | 0,
  };
  registry.add(client);
  log("ws/audio", "client connected", { id, remoteAddr: client.remoteAddr });
  try { ws.send(JSON.stringify({ type: "hello", clientId: id })); } catch { /* ignore */ }
  scheduler.sendTransportTo(client);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: unknown;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "ping" && typeof m.t0 === "number") {
      try {
        ws.send(JSON.stringify({ type: "pong", t0: m.t0, t1: Number(nowNs()) }));
      } catch { /* ignore */ }
    } else if (m.type === "announce" && typeof m.name === "string") {
      const name = m.name.slice(0, 64);
      registry.setName(id, name);
      log("ws/audio", "client announced", { id, name });
    } else if (m.type === "late" && typeof m.count === "number") {
      if (m.count > client.framesLate) {
        log("ws/audio", "client reports late frames", { id, name: client.name, count: m.count });
      }
      client.framesLate = m.count;
      broadcastControl();
    }
  });

  ws.on("close", () => {
    log("ws/audio", "client disconnected", { id, name: client.name });
    registry.remove(id);
  });
  ws.on("error", (err) => {
    logErr("ws/audio", "socket error", { id, error: (err as Error).message });
  });
});

controlWss.on("connection", (ws, req) => {
  controlSockets.add(ws);
  log("ws/ctl", "host UI connected", { remoteAddr: req.socket.remoteAddress ?? "?" });
  broadcastControl();
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: unknown;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "play") {
      log("transport", "play");
      scheduler.play();
    } else if (m.type === "pause") {
      log("transport", "pause");
      scheduler.pause();
    } else if (m.type === "seek" && typeof m.positionSec === "number") {
      log("transport", "seek", { positionSec: Number(m.positionSec.toFixed(3)) });
      scheduler.seek(m.positionSec);
    } else if (m.type === "assign" && typeof m.id === "string" && typeof m.channel === "string") {
      log("registry", "assign channel", { id: m.id, channel: m.channel });
      registry.setChannel(m.id, m.channel as Channel);
    } else if (m.type === "rename" && typeof m.id === "string" && typeof m.name === "string") {
      const name = m.name.slice(0, 64);
      log("registry", "rename client", { id: m.id, name });
      registry.setName(m.id, name);
    } else if (m.type === "forceSync") {
      const all = registry.all();
      log("transport", "force-sync", { clients: all.length });
      const payload = JSON.stringify({ type: "resync" });
      for (const c of all) {
        c.framesLate = 0;
        try { c.ws.send(payload); } catch { /* ignore */ }
      }
      broadcastControl();
    }
  });
  ws.on("close", () => {
    controlSockets.delete(ws);
    log("ws/ctl", "host UI disconnected");
  });
});

function lanUrls(): string[] {
  const urls: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) {
        urls.push(`http://${i.address}:${PORT}`);
      }
    }
  }
  return urls;
}

setInterval(broadcastControl, 1000);

server.listen(PORT, () => {
  console.log(`music-sync host listening on :${PORT}`);
  console.log(`  host UI:    http://localhost:${PORT}/`);
  console.log(`  client URL: http://localhost:${PORT}/client`);
  for (const u of lanUrls()) console.log(`  on LAN:     ${u}/client`);
});
