import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_MESSAGE_HISTORY = 100;
const DEFAULT_ROOMS = ["general", "random", "support"];

const allowedOrigins = (
  process.env.CLIENT_ORIGINS ??
  process.env.CLIENT_ORIGIN ??
  "http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function allowOrigin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`));
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowOrigin,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: allowOrigin }));
app.use(express.json());

const rooms = new Map();
const onlineConnections = new Map();
const privateMessages = new Map();

function cleanText(value, maxLength) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeRoom(value) {
  const roomName = cleanText(value, 32)
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-");

  return roomName || "general";
}

function createRoom(roomName) {
  return {
    name: roomName,
    users: new Map(),
    messages: []
  };
}

function getRoom(roomName) {
  const normalizedRoom = normalizeRoom(roomName);

  if (!rooms.has(normalizedRoom)) {
    rooms.set(normalizedRoom, createRoom(normalizedRoom));
  }

  return rooms.get(normalizedRoom);
}

function trimHistory(room) {
  if (room.messages.length > MAX_MESSAGE_HISTORY) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGE_HISTORY);
  }
}

function trimMessageHistory(messages) {
  if (messages.length > MAX_MESSAGE_HISTORY) {
    messages.splice(0, messages.length - MAX_MESSAGE_HISTORY);
  }
}

function makeMessage({ room, userId = null, username, text, type = "user" }) {
  return {
    id: randomUUID(),
    room,
    userId,
    username,
    text,
    type,
    createdAt: new Date().toISOString()
  };
}

function getUsers(room) {
  return Array.from(room.users.entries())
    .map(([connectionId, user]) => ({
      connectionId,
      id: user.id,
      name: user.name
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function getRoomSummaries() {
  return Array.from(rooms.values())
    .map((room) => ({
      name: room.name,
      userCount: room.users.size,
      lastMessage: room.messages.at(-1) ?? null
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function broadcastRooms() {
  io.emit("rooms:update", { rooms: getRoomSummaries() });
}

function getPrivateRoomName(userId) {
  return `private:${userId}`;
}

function getConversationKey(firstUserId, secondUserId) {
  return [firstUserId, secondUserId].sort().join(":");
}

function getOnlineUsers() {
  const usersById = new Map();

  for (const user of onlineConnections.values()) {
    const existingUser = usersById.get(user.id);

    if (existingUser) {
      existingUser.connectionCount += 1;
    } else {
      usersById.set(user.id, {
        id: user.id,
        name: user.name,
        connectionCount: 1
      });
    }
  }

  return Array.from(usersById.values()).sort((first, second) =>
    first.name.localeCompare(second.name)
  );
}

function broadcastOnlineUsers() {
  io.emit("online:users", { users: getOnlineUsers() });
}

function registerOnlineUser(socket, userId, username) {
  if (socket.data.userId && socket.data.userId !== userId) {
    socket.leave(getPrivateRoomName(socket.data.userId));
  }

  socket.data.userId = userId;
  socket.data.username = username;
  socket.join(getPrivateRoomName(userId));
  onlineConnections.set(socket.id, { id: userId, name: username });
  broadcastOnlineUsers();
}

function unregisterOnlineUser(socket) {
  const userId = socket.data.userId;
  const wasOnline = onlineConnections.delete(socket.id);

  if (userId) {
    socket.leave(getPrivateRoomName(userId));
  }

  if (wasOnline) {
    broadcastOnlineUsers();
  }
}

function addSystemMessage(room, text) {
  const message = makeMessage({
    room: room.name,
    username: "system",
    text,
    type: "system"
  });

  room.messages.push(message);
  trimHistory(room);

  return message;
}

function leaveCurrentRoom(socket) {
  const roomName = socket.data.room;
  const username = socket.data.username;

  if (!roomName || !username) {
    return;
  }

  const room = rooms.get(roomName);

  if (!room || !room.users.delete(socket.id)) {
    return;
  }

  const message = addSystemMessage(room, `${username} left #${roomName}`);

  socket.leave(roomName);
  socket.to(roomName).emit("chat:message", message);
  io.to(roomName).emit("room:users", { room: roomName, users: getUsers(room) });
  socket.data.room = undefined;
  broadcastRooms();
}

for (const roomName of DEFAULT_ROOMS) {
  rooms.set(roomName, createRoom(roomName));
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    roomCount: rooms.size,
    socketCount: io.engine.clientsCount
  });
});

app.post("/api/login", (request, response) => {
  const username = cleanText(request.body?.username, 24);

  if (!username) {
    response.status(400).json({ ok: false, error: "Display name is required." });
    return;
  }

  response.json({
    ok: true,
    user: {
      id: randomUUID(),
      username
    }
  });
});

app.get("/api/rooms", (_request, response) => {
  response.json({ rooms: getRoomSummaries() });
});

app.get("/api/rooms/:room/messages", (request, response) => {
  const room = getRoom(request.params.room);

  response.json({
    room: room.name,
    messages: room.messages
  });
});

io.on("connection", (socket) => {
  socket.emit("rooms:update", { rooms: getRoomSummaries() });
  socket.emit("online:users", { users: getOnlineUsers() });

  socket.on("room:join", (payload = {}, acknowledge = () => {}) => {
    const username = cleanText(payload.username, 24);
    const userId = cleanText(payload.userId, 64) || randomUUID();

    if (!username) {
      acknowledge({ ok: false, error: "Display name is required." });
      return;
    }

    const room = getRoom(payload.room);

    if (
      socket.data.room === room.name &&
      socket.data.username === username &&
      socket.data.userId === userId
    ) {
      acknowledge({ ok: true, room: room.name });
      return;
    }

    leaveCurrentRoom(socket);
    registerOnlineUser(socket, userId, username);

    socket.data.room = room.name;
    socket.join(room.name);
    room.users.set(socket.id, { id: userId, name: username });

    const message = addSystemMessage(room, `${username} joined #${room.name}`);

    socket.emit("room:joined", {
      room: room.name,
      messages: room.messages,
      users: getUsers(room)
    });
    socket.to(room.name).emit("chat:message", message);
    io.to(room.name).emit("room:users", { room: room.name, users: getUsers(room) });
    broadcastRooms();
    acknowledge({ ok: true, room: room.name });
  });

  socket.on("private:history", (payload = {}, acknowledge = () => {}) => {
    const fromUserId = socket.data.userId;
    const toUserId = cleanText(payload.userId, 64);

    if (!fromUserId || !socket.data.username) {
      acknowledge({ ok: false, error: "Login before opening private chat." });
      return;
    }

    if (!toUserId || toUserId === fromUserId) {
      acknowledge({ ok: false, error: "Choose another online user." });
      return;
    }

    const conversationKey = getConversationKey(fromUserId, toUserId);

    acknowledge({
      ok: true,
      messages: privateMessages.get(conversationKey) ?? []
    });
  });

  socket.on("private:send", (payload = {}, acknowledge = () => {}) => {
    const fromUserId = socket.data.userId;
    const fromUsername = socket.data.username;
    const toUserId = cleanText(payload.toUserId, 64);
    const text = cleanText(payload.message, 1000);
    const recipient = getOnlineUsers().find((user) => user.id === toUserId);

    if (!fromUserId || !fromUsername) {
      acknowledge({ ok: false, error: "Login before sending private messages." });
      return;
    }

    if (!toUserId || toUserId === fromUserId) {
      acknowledge({ ok: false, error: "Choose another online user." });
      return;
    }

    if (!recipient) {
      acknowledge({ ok: false, error: "That user is not online." });
      return;
    }

    if (!text) {
      acknowledge({ ok: false, error: "Message is required." });
      return;
    }

    const conversationKey = getConversationKey(fromUserId, toUserId);
    const conversationMessages = privateMessages.get(conversationKey) ?? [];
    const message = {
      id: randomUUID(),
      conversationKey,
      fromUserId,
      fromUsername,
      toUserId,
      toUsername: recipient.name,
      text,
      createdAt: new Date().toISOString()
    };

    conversationMessages.push(message);
    trimMessageHistory(conversationMessages);
    privateMessages.set(conversationKey, conversationMessages);

    io.to(getPrivateRoomName(fromUserId))
      .to(getPrivateRoomName(toUserId))
      .emit("private:message", message);
    acknowledge({ ok: true, message });
  });

  socket.on("chat:send", (payload = {}, acknowledge = () => {}) => {
    const roomName = socket.data.room;
    const username = socket.data.username;
    const text = cleanText(payload.message, 1000);

    if (!roomName || !username) {
      acknowledge({ ok: false, error: "Join a room before sending messages." });
      return;
    }

    if (!text) {
      acknowledge({ ok: false, error: "Message is required." });
      return;
    }

    const room = getRoom(roomName);
    const message = makeMessage({
      room: room.name,
      userId: socket.data.userId,
      username,
      text
    });

    room.messages.push(message);
    trimHistory(room);

    io.to(room.name).emit("chat:message", message);
    broadcastRooms();
    acknowledge({ ok: true, message });
  });

  socket.on("typing:start", () => {
    const roomName = socket.data.room;
    const userId = socket.data.userId;
    const username = socket.data.username;

    if (roomName && username) {
      socket.to(roomName).emit("typing:update", { userId, username, isTyping: true });
    }
  });

  socket.on("typing:stop", () => {
    const roomName = socket.data.room;
    const userId = socket.data.userId;
    const username = socket.data.username;

    if (roomName && username) {
      socket.to(roomName).emit("typing:update", { userId, username, isTyping: false });
    }
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    unregisterOnlineUser(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Chat backend listening on http://localhost:${PORT}`);
});
