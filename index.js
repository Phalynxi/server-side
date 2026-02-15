const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const rooms = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;
const COLORS = ["#ff5858", "#58b0ff", "#58ffa8", "#ffb858", "#a858ff", "#ff58c4"];

function log(message, extra) {
  const base = `[${new Date().toISOString()}] ${message}`;
  if (extra) {
    console.log(base, extra);
  } else {
    console.log(base);
  }
}

function normalizeRoomCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function getRoom(code) {
  const now = Date.now();
  const existing = rooms.get(code);
  if (existing && now - existing.updatedAt < TTL_MS) return existing;
  if (existing) rooms.delete(code);
  const fresh = { offer: null, answer: null, doc: "", clients: new Map(), updatedAt: now };
  rooms.set(code, fresh);
  return fresh;
}

function setRoomPayload(code, type, payload) {
  const room = getRoom(code);
  room[type] = payload;
  room.updatedAt = Date.now();
}

function getRoomPayload(code, type) {
  const room = getRoom(code);
  const payload = room[type];
  return payload || { pending: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.updatedAt > TTL_MS) {
      rooms.delete(code);
      log("room expired", { room: code });
    }
  }
}, 30 * 60 * 1000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/room", (_req, res) => {
  const code = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
  getRoom(code);
  log("room created", { room: code });
  res.json({ code });
});

app.post("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  setRoomPayload(code, type, req.body || {});
  log("signal set", { room: code, type, size: JSON.stringify(req.body || {}).length });
  res.json({ ok: true });
});

app.put("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  setRoomPayload(code, type, req.body || {});
  log("signal set", { room: code, type, size: JSON.stringify(req.body || {}).length });
  res.json({ ok: true });
});

app.get("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  const payload = getRoomPayload(code, type);
  log("signal get", { room: code, type, pending: !!payload?.pending });
  res.json(payload);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

function nextColor(room) {
  const used = new Set([...room.clients.values()].map(c => c.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function broadcast(room, payload, except) {
  const msg = JSON.stringify(payload);
  for (const { ws } of room.clients.values()) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function presencePayload(room) {
  return { type: "presence", clients: [...room.clients.values()].map(c => ({ id: c.id, color: c.color })) };
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = normalizeRoomCode(url.searchParams.get("room"));
    if (code.length !== 5) {
      ws.close();
      return;
    }
    const room = getRoom(code);
    const id = `c_${Math.random().toString(36).slice(2, 9)}`;
    const color = nextColor(room);
    room.clients.set(id, { ws, id, color });
    room.updatedAt = Date.now();
    log("ws connect", { room: code, clients: room.clients.size });
    ws.send(JSON.stringify({ type: "welcome", id, color }));
    ws.send(JSON.stringify({ type: "init", code: room.doc || "" }));
    ws.send(JSON.stringify(presencePayload(room)));
    broadcast(room, presencePayload(room), ws);
    ws.on("message", data => {
      try {
        const msg = JSON.parse(String(data || "{}"));
        if (msg.type === "code" && typeof msg.code === "string") {
          room.doc = msg.code;
          room.updatedAt = Date.now();
          broadcast(room, { type: "code", code: msg.code }, ws);
          log("ws code", { room: code, size: msg.code.length });
          return;
        }
        if (msg.type === "cursor" && msg.selection) {
          broadcast(room, { type: "cursor", id, selection: msg.selection }, ws);
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify(presencePayload(room)));
          return;
        }
        if (msg.type === "hello") {
          log("ws hello", { room: code, role: msg.role || "unknown" });
        }
      } catch (_) {}
    });
    ws.on("close", () => {
      for (const [clientId, client] of room.clients.entries()) {
        if (client.ws === ws) {
          room.clients.delete(clientId);
          break;
        }
      }
      room.updatedAt = Date.now();
      log("ws close", { room: code, clients: room.clients.size });
      broadcast(room, presencePayload(room));
    });
  } catch (_) {
    ws.close();
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`TeamCreate server running on :${PORT}`);
  });
}

module.exports = { app, server };
