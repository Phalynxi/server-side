const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const rooms = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

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
  const fresh = { offer: null, answer: null, doc: "", clients: new Set(), updatedAt: now };
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

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = normalizeRoomCode(url.searchParams.get("room"));
    if (code.length !== 5) {
      ws.close();
      return;
    }
    const room = getRoom(code);
    room.clients.add(ws);
    room.updatedAt = Date.now();
    log("ws connect", { room: code, clients: room.clients.size });
    ws.send(JSON.stringify({ type: "init", code: room.doc || "" }));
    ws.on("message", data => {
      try {
        const msg = JSON.parse(String(data || "{}"));
        if (msg.type === "code" && typeof msg.code === "string") {
          room.doc = msg.code;
          room.updatedAt = Date.now();
          for (const client of room.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: "code", code: msg.code }));
            }
          }
          log("ws code", { room: code, size: msg.code.length });
          return;
        }
        if (msg.type === "hello") {
          log("ws hello", { room: code, role: msg.role || "unknown" });
        }
      } catch (_) {}
    });
    ws.on("close", () => {
      room.clients.delete(ws);
      room.updatedAt = Date.now();
      log("ws close", { room: code, clients: room.clients.size });
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
