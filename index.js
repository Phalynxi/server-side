const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const rooms = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

function normalizeRoomCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function getRoom(code) {
  const now = Date.now();
  const existing = rooms.get(code);
  if (existing && now - existing.updatedAt < TTL_MS) return existing;
  if (existing) rooms.delete(code);
  const fresh = { offer: null, answer: null, updatedAt: now };
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
    if (now - room.updatedAt > TTL_MS) rooms.delete(code);
  }
}, 30 * 60 * 1000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/room", (_req, res) => {
  const code = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
  getRoom(code);
  res.json({ code });
});

app.post("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  setRoomPayload(code, type, req.body || {});
  res.json({ ok: true });
});

app.put("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  setRoomPayload(code, type, req.body || {});
  res.json({ ok: true });
});

app.get("/api/signal/:room/:type", (req, res) => {
  const code = normalizeRoomCode(req.params.room);
  const type = req.params.type;
  if (code.length !== 5) return res.status(400).json({ ok: false, error: "invalid_room" });
  if (type !== "offer" && type !== "answer") return res.status(400).json({ ok: false, error: "invalid_type" });
  res.json(getRoomPayload(code, type));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TeamCreate server running on :${PORT}`);
  });
}

module.exports = { app };
