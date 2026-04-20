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

const PORT = Number(process.env.PORT ?? 7000);
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
  await mkdir(UPLOAD_DIR, { recursive: true });
  const suggestedName = (req.headers["x-file-name"] as string | undefined) ?? `upload-${Date.now()}`;
  const safeName = basename(suggestedName).replace(/[^A-Za-z0-9._-]/g, "_");
  const targetPath = join(UPLOAD_DIR, `${randomUUID()}-${safeName}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).byteLength;
    if (total > 500 * 1024 * 1024) {
      res.writeHead(413); res.end("file too large (500MB cap)"); return;
    }
  }
  await writeFile(targetPath, Buffer.concat(chunks));
  try {
    const track = await decodeFileToPcm(targetPath, safeName);
    scheduler.loadTrack(track);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: safeName, durationSec: track.durationSec }));
  } catch (err) {
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
      registry.setName(id, m.name.slice(0, 64));
    } else if (m.type === "late" && typeof m.count === "number") {
      client.framesLate = m.count;
      broadcastControl();
    }
  });

  ws.on("close", () => registry.remove(id));
});

controlWss.on("connection", (ws) => {
  controlSockets.add(ws);
  broadcastControl();
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: unknown;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "play") scheduler.play();
    else if (m.type === "pause") scheduler.pause();
    else if (m.type === "seek" && typeof m.positionSec === "number") scheduler.seek(m.positionSec);
    else if (m.type === "assign" && typeof m.id === "string" && typeof m.channel === "string") {
      registry.setChannel(m.id, m.channel as Channel);
    } else if (m.type === "rename" && typeof m.id === "string" && typeof m.name === "string") {
      registry.setName(m.id, m.name.slice(0, 64));
    }
  });
  ws.on("close", () => controlSockets.delete(ws));
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
