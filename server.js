// ─────────────────────────────────────────────────────────────
//  BitMask — Anonymous Encrypted Chat Server
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 25 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES = 2 * 1024 * 1024;
const configuredCorsOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || configuredCorsOrigins.includes('*') || configuredCorsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin is not allowed by CORS.'));
      }
    },
    methods: ['GET', 'POST'],
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: MAX_FILE_CHUNK_BYTES,
});

// ── Security Middleware ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https:", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
    },
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for HTTP requests
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
app.use(limiter);

// ── In-Memory Volatile State ─────────────────────────────────
// peerID -> { socketId, publicKey, connectedTo }
const peers = new Map();
// socketId -> peerID (reverse lookup)
const socketToPeer = new Map();
// roomId -> { members: Map<peerId, publicKey>, host, roomCode, isGroup, createdAt }
const rooms = new Map();
// roomCode -> roomId (reverse lookup for group join)
const roomCodes = new Map();
// peerID -> [{ id, from, cipher, nonce, ttl, timestamp }]
const pendingMessages = new Map();
// File transfers keep only short-lived metadata in RAM. Encrypted chunks are relayed, never persisted.
const fileTransfers = new Map();
// Rate limiting for socket events per IP
const socketRateMap = new Map();
// Invite tokens are short-lived, single-use capabilities. They never contain
// message content or private keys and are kept only in volatile memory.
const invites = new Map();

// ── Helpers ──────────────────────────────────────────────────

function generatePeerId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function generateRoomId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateMessageId() {
  return crypto.randomBytes(12).toString('hex');
}

function generateRoomCode() {
  // 6-char alphanumeric code (uppercase, no ambiguous chars)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function generateInviteToken() {
  return crypto.randomBytes(12).toString('hex').toUpperCase();
}

function invitePayload(kind, token) {
  return `BM1/${kind === 'room' ? 'R' : 'P'}/${token}`;
}

function getValidInvite(token, kind, expectedValue, consumerPeerId) {
  if (!token || typeof token !== 'string') return { error: 'Invite token required.' };
  const invite = invites.get(token.toUpperCase());
  if (!invite) return { error: 'Invite expired or already used.' };
  if (invite.expiresAt <= Date.now()) {
    invites.delete(token.toUpperCase());
    return { error: 'Invite expired.' };
  }
  if (kind && invite.kind !== kind) return { error: 'Invite type does not match this action.' };
  if (expectedValue && invite.value !== expectedValue) return { error: 'Invite target does not match.' };
  if (consumerPeerId && invite.createdBy === consumerPeerId) return { error: 'You cannot use your own invite.' };
  return { invite, token: token.toUpperCase() };
}

function consumeInvite(token, kind, expectedValue, consumerPeerId) {
  const result = getValidInvite(token, kind, expectedValue, consumerPeerId);
  if (result.error) return result;
  invites.delete(result.token);
  return result;
}

function isRateLimited(ip, maxPerMinute = 60) {
  const now = Date.now();
  if (!socketRateMap.has(ip)) {
    socketRateMap.set(ip, []);
  }
  const timestamps = socketRateMap.get(ip).filter(t => now - t < 60000);
  timestamps.push(now);
  socketRateMap.set(ip, timestamps);
  return timestamps.length > maxPerMinute;
}

function normalizeMessageTtl(value, fallback = 30000) {
  if (value === 0 || value === '0') return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, 5000), 86400000);
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of socketRateMap) {
    const fresh = timestamps.filter(t => now - t < 60000);
    if (fresh.length === 0) socketRateMap.delete(ip);
    else socketRateMap.set(ip, fresh);
  }
}, 300000);

setInterval(() => {
  const now = Date.now();
  for (const [id, transfer] of fileTransfers) {
    if (transfer.expiresAt <= now) fileTransfers.delete(id);
  }
}, 60000);

setInterval(() => {
  const now = Date.now();
  for (const [token, invite] of invites) {
    if (invite.expiresAt <= now) invites.delete(token);
  }
}, 15000);

// ── REST Endpoints ───────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', peers: peers.size, rooms: rooms.size });
});

// ── Socket.io Logic ──────────────────────────────────────────

io.on('connection', (socket) => {
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  const ip = typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : socket.handshake.address;

  socket.on('connection-ping', (_payload, callback) => {
    callback?.({ timestamp: Date.now() });
  });

  // ── Create a short-lived QR/link invite ─────────────────────
  socket.on('create-invite', ({ kind = 'peer', roomId, ttlMs } = {}, callback) => {
    if (isRateLimited(ip, 30)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback?.({ error: 'You must register first.' });

    const safeKind = kind === 'room' ? 'room' : 'peer';
    const safeTtl = Math.min(Math.max(Number(ttlMs) || 300000, 60000), 3600000);
    let value;

    if (safeKind === 'room') {
      const room = rooms.get(roomId);
      if (!room || !room.isGroup || !room.members.has(myPeerId)) {
        return callback?.({ error: 'Group room not found.' });
      }
      value = room.roomCode;
    } else {
      value = myPeerId;
    }

    const token = generateInviteToken();
    const expiresAt = Date.now() + safeTtl;
    invites.set(token, {
      kind: safeKind,
      value,
      roomId: safeKind === 'room' ? roomId : null,
      createdBy: myPeerId,
      expiresAt,
    });

    callback?.({
      success: true,
      kind: safeKind,
      token,
      payload: invitePayload(safeKind, token),
      value,
      expiresAt,
      ttlMs: safeTtl,
    });
  });

  // Resolve an invite without consuming it. The follow-up connect/join event
  // consumes it only after the requested operation succeeds.
  socket.on('redeem-invite', ({ token } = {}, callback) => {
    if (isRateLimited(ip, 60)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const result = getValidInvite(token);
    if (result.error) return callback?.({ error: result.error });

    const { invite } = result;
    if (invite.kind === 'peer' && !peers.has(invite.value)) {
      return callback?.({ error: 'Peer is offline.' });
    }
    if (invite.kind === 'room' && !roomCodes.has(invite.value)) {
      return callback?.({ error: 'Room no longer exists.' });
    }

    callback?.({
      success: true,
      kind: invite.kind,
      value: invite.value,
      token: result.token,
      expiresAt: invite.expiresAt,
    });
  });

  // ── Register Peer ──────────────────────────────────────────
  socket.on('register', ({ peerId, publicKey }, callback) => {
    if (isRateLimited(ip)) {
      return callback({ error: 'Rate limited. Slow down.' });
    }

    if (!peerId || typeof peerId !== 'string' || peerId.length !== 16) {
      return callback({ error: 'Invalid Peer ID format.' });
    }

    if (!publicKey) {
      return callback({ error: 'Public key required for E2EE.' });
    }

    // If this peerId is already taken by another socket, reject
    if (peers.has(peerId) && peers.get(peerId).socketId !== socket.id) {
      return callback({ error: 'Peer ID collision. Regenerate.' });
    }

    // Clean up any previous registration for this socket
    const prevPeerId = socketToPeer.get(socket.id);
    if (prevPeerId && prevPeerId !== peerId) {
      peers.delete(prevPeerId);
    }

    peers.set(peerId, {
      socketId: socket.id,
      publicKey,
      connectedTo: null,
    });
    socketToPeer.set(socket.id, peerId);

    console.log(`[+] Peer registered: ${peerId.slice(0, 6)}...`);
    callback({ success: true });

    // Deliver any pending messages
    if (pendingMessages.has(peerId)) {
      const msgs = pendingMessages.get(peerId);
      msgs.forEach(msg => socket.emit('message', msg));
      pendingMessages.delete(peerId);
    }
  });

  // ── Connect to Peer (1:1 Direct Chat) ──────────────────────
  socket.on('connect-to-peer', ({ targetPeerId, inviteToken }, callback) => {
    if (isRateLimited(ip)) {
      return callback({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback({ error: 'You must register first.' });

    if (targetPeerId === myPeerId) {
      return callback({ error: 'Cannot connect to yourself.' });
    }

    const target = peers.get(targetPeerId);
    if (!target) {
      return callback({ error: 'Peer not found or offline.' });
    }

    if (inviteToken) {
      const inviteResult = consumeInvite(inviteToken, 'peer', targetPeerId, myPeerId);
      if (inviteResult.error) return callback({ error: inviteResult.error });
    }

    // Create a room with new model
    const roomId = generateRoomId();
    const myPeer = peers.get(myPeerId);
    const members = new Map();
    members.set(myPeerId, myPeer.publicKey);
    members.set(targetPeerId, target.publicKey);

    rooms.set(roomId, {
      members,
      host: myPeerId,
      roomCode: null,
      isGroup: false,
      createdAt: Date.now(),
    });

    // Update peer states
    myPeer.connectedTo = targetPeerId;
    target.connectedTo = myPeerId;

    // Join socket room
    socket.join(roomId);
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) targetSocket.join(roomId);

    // Notify both sides
    callback({
      success: true,
      roomId,
      peerPublicKey: target.publicKey,
    });

    if (targetSocket) {
      targetSocket.emit('peer-connected', {
        roomId,
        peerId: myPeerId,
        peerPublicKey: myPeer.publicKey,
      });
    }

    console.log(`[~] Room created: ${myPeerId.slice(0, 6)} <-> ${targetPeerId.slice(0, 6)}`);
  });

  // ── Create Group Room ──────────────────────────────────────
  socket.on('create-room', (data, callback) => {
    if (isRateLimited(ip)) {
      return callback({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback({ error: 'You must register first.' });

    const myPeer = peers.get(myPeerId);
    const roomId = generateRoomId();
    let roomCode = generateRoomCode();

    // Ensure unique room code
    while (roomCodes.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const members = new Map();
    members.set(myPeerId, myPeer.publicKey);

    rooms.set(roomId, {
      members,
      host: myPeerId,
      roomCode,
      isGroup: true,
      createdAt: Date.now(),
    });
    roomCodes.set(roomCode, roomId);

    socket.join(roomId);

    console.log(`[+] Group room created: ${roomCode} by ${myPeerId.slice(0, 6)}...`);
    callback({
      success: true,
      roomId,
      roomCode,
    });
  });

  // ── Join Group Room ────────────────────────────────────────
  socket.on('join-room', ({ roomCode: code, inviteToken }, callback) => {
    if (isRateLimited(ip)) {
      return callback({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback({ error: 'You must register first.' });

    if (!code || typeof code !== 'string') {
      return callback({ error: 'Invalid room code.' });
    }

    const normalCode = code.trim().toUpperCase();
    const roomId = roomCodes.get(normalCode);
    if (!roomId) return callback({ error: 'Room not found.' });

    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room no longer exists.' });

    if (room.members.has(myPeerId)) {
      return callback({ error: 'You are already in this room.' });
    }

    if (room.members.size >= 20) {
      return callback({ error: 'Room is full (max 20 members).' });
    }

    if (inviteToken) {
      const inviteResult = consumeInvite(inviteToken, 'room', normalCode, myPeerId);
      if (inviteResult.error) return callback({ error: inviteResult.error });
    }

    const myPeer = peers.get(myPeerId);

    // Build member list for the new joiner (existing members with their public keys)
    const existingMembers = [];
    for (const [pid, pubKey] of room.members) {
      existingMembers.push({ peerId: pid, publicKey: pubKey });
    }

    // Add new member to room
    room.members.set(myPeerId, myPeer.publicKey);
    socket.join(roomId);

    // Notify the new joiner with room info and existing member list
    callback({
      success: true,
      roomId,
      roomCode: normalCode,
      host: room.host,
      members: existingMembers,
    });

    // Notify existing members about the new joiner
    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const p = peers.get(pid);
      if (p) {
        const ps = io.sockets.sockets.get(p.socketId);
        if (ps) {
          ps.emit('peer-joined', {
            roomId,
            peerId: myPeerId,
            publicKey: myPeer.publicKey,
            memberCount: room.members.size,
          });
        }
      }
    }

    console.log(`[+] ${myPeerId.slice(0, 6)}... joined group ${normalCode} (${room.members.size} members)`);
  });

  // ── Distribute Group Key ───────────────────────────────────
  // Host sends the encrypted group key to a specific peer
  socket.on('distribute-key', ({ roomId, targetPeerId, encryptedKey, nonce }, callback) => {
    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback?.({ error: 'Not registered.' });

    const room = rooms.get(roomId);
    if (!room) return callback?.({ error: 'Room not found.' });

    if (room.host !== myPeerId) {
      return callback?.({ error: 'Only the host can distribute keys.' });
    }

    const target = peers.get(targetPeerId);
    if (!target) return callback?.({ error: 'Target peer offline.' });

    const ts = io.sockets.sockets.get(target.socketId);
    if (ts) {
      ts.emit('group-key', {
        roomId,
        fromPeerId: myPeerId,
        fromPublicKey: peers.get(myPeerId).publicKey,
        encryptedKey,
        nonce,
      });
    }

    callback?.({ success: true });
  });

  // ── Send Encrypted Message ─────────────────────────────────
  socket.on('send-message', ({ roomId, cipher, nonce, ttl }, callback) => {
    if (isRateLimited(ip, 120)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback?.({ error: 'Not registered.' });

    const room = rooms.get(roomId);
    if (!room) return callback?.({ error: 'Room not found.' });

    if (!room.members.has(myPeerId)) {
      return callback?.({ error: 'Not a member of this room.' });
    }

    const msgId = generateMessageId();

    const message = {
      id: msgId,
      from: myPeerId,
      cipher,
      nonce,
       ttl: normalizeMessageTtl(ttl, 5000), // Off or 5s – 24h
      timestamp: Date.now(),
    };

    // Broadcast to all other members
    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      if (target) {
        const ts = io.sockets.sockets.get(target.socketId);
        if (ts) {
          ts.emit('message', message);
        } else {
          // Queue for offline peer
          if (!pendingMessages.has(pid)) pendingMessages.set(pid, []);
          pendingMessages.get(pid).push(message);
        }
      }
    }

    // Schedule server-side deletion of any queued copies
     const safeTtl = message.ttl;
     if (safeTtl > 0) {
       setTimeout(() => {
         for (const [pid] of room.members) {
           if (pid === myPeerId) continue;
           if (pendingMessages.has(pid)) {
             const q = pendingMessages.get(pid).filter(m => m.id !== msgId);
             if (q.length === 0) pendingMessages.delete(pid);
             else pendingMessages.set(pid, q);
           }
         }
       }, safeTtl);
     }

    callback?.({ success: true, msgId });
  });

  // ── Message Read ACK (delete-after-read) ───────────────────
  socket.on('message-ack', ({ msgId }) => {
    const peerId = socketToPeer.get(socket.id);
    if (!peerId || !pendingMessages.has(peerId)) return;
    const q = pendingMessages.get(peerId).filter(m => m.id !== msgId);
    if (q.length === 0) pendingMessages.delete(peerId);
    else pendingMessages.set(peerId, q);
  });

  // ── Chunked Encrypted File Transfer ─────────────────────────
  // Only encrypted frames cross the server. The server stores transfer
  // metadata briefly so chunks can be authenticated and routed.
  socket.on('send-file-start', ({ roomId, metadata, ttl, chunkCount }, callback) => {
    if (isRateLimited(ip, 45)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback?.({ error: 'Not registered.' });

    const room = rooms.get(roomId);
    if (!room) return callback?.({ error: 'Room not found.' });
    if (!room.members.has(myPeerId)) return callback?.({ error: 'Not a member of this room.' });

    if (
      !metadata ||
      typeof metadata.name !== 'string' ||
      metadata.name.trim().length === 0 ||
      metadata.name.length > 160 ||
      !Number.isFinite(Number(metadata.size)) ||
      Number(metadata.size) < 0
    ) {
      return callback?.({ error: 'Invalid file metadata.' });
    }

    const fileSize = Math.floor(Number(metadata.size));
    if (fileSize > MAX_FILE_SIZE) {
      return callback?.({ error: `File too large. Max ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB.` });
    }

    const count = Number(chunkCount);
    if (!Number.isInteger(count) || count < 1 || count > 128) {
      return callback?.({ error: 'Invalid file chunk count.' });
    }

    if (metadata.mimeType !== undefined && (
      typeof metadata.mimeType !== 'string' || metadata.mimeType.length > 120
    )) {
      return callback?.({ error: 'Invalid file type.' });
    }

    const msgId = generateMessageId();
     const safeTtl = normalizeMessageTtl(ttl, 30000);
    const safeMetadata = { ...metadata, size: fileSize };
    fileTransfers.set(msgId, {
      roomId,
      from: myPeerId,
      metadata: safeMetadata,
      ttl: safeTtl,
      chunkCount: count,
       expiresAt: Date.now() + (safeTtl > 0 ? safeTtl : 86400000),
    });

    const startMessage = {
      id: msgId,
      from: myPeerId,
      metadata: safeMetadata,
      ttl: safeTtl,
      chunkCount: count,
      timestamp: Date.now(),
    };

    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      const targetSocket = target && io.sockets.sockets.get(target.socketId);
      targetSocket?.emit('file-start', startMessage);
    }

    callback?.({ success: true, msgId });
  });

  socket.on('send-file-chunk', ({ roomId, msgId, index, cipher, nonce }, callback) => {
    if (isRateLimited(ip, 180)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    const transfer = fileTransfers.get(msgId);
    if (!myPeerId || !transfer) return callback?.({ error: 'File transfer not found.' });
    if (transfer.roomId !== roomId || transfer.from !== myPeerId) {
      return callback?.({ error: 'Invalid file transfer.' });
    }

    const room = rooms.get(roomId);
    if (!room || !room.members.has(myPeerId)) return callback?.({ error: 'Not a member of this room.' });

    const chunkIndex = Number(index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.chunkCount) {
      return callback?.({ error: 'Invalid file chunk index.' });
    }
    if (
      typeof cipher !== 'string' || cipher.length === 0 || cipher.length > MAX_FILE_CHUNK_BYTES * 2 ||
      typeof nonce !== 'string' || nonce.length > 64
    ) {
      return callback?.({ error: 'Invalid encrypted file chunk.' });
    }

    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      const targetSocket = target && io.sockets.sockets.get(target.socketId);
      targetSocket?.emit('file-chunk', {
        id: msgId,
        index: chunkIndex,
        cipher,
        nonce,
      });
    }

    callback?.({ success: true });
  });

  socket.on('send-file-complete', ({ roomId, msgId }, callback) => {
    const myPeerId = socketToPeer.get(socket.id);
    const transfer = fileTransfers.get(msgId);
    if (!myPeerId || !transfer) return callback?.({ error: 'File transfer not found.' });
    if (transfer.roomId !== roomId || transfer.from !== myPeerId) {
      return callback?.({ error: 'Invalid file transfer.' });
    }

    const room = rooms.get(roomId);
    if (!room || !room.members.has(myPeerId)) return callback?.({ error: 'Not a member of this room.' });

    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      const targetSocket = target && io.sockets.sockets.get(target.socketId);
      targetSocket?.emit('file-complete', { id: msgId });
    }

    fileTransfers.delete(msgId);
    callback?.({ success: true });
  });

  socket.on('send-file-cancel', ({ roomId, msgId }, callback) => {
    const myPeerId = socketToPeer.get(socket.id);
    const transfer = fileTransfers.get(msgId);
    if (!myPeerId || !transfer) return callback?.({ error: 'File transfer not found.' });
    if (transfer.roomId !== roomId || transfer.from !== myPeerId) {
      return callback?.({ error: 'Invalid file transfer.' });
    }

    const room = rooms.get(roomId);
    if (!room || !room.members.has(myPeerId)) return callback?.({ error: 'Not a member of this room.' });

    fileTransfers.delete(msgId);
    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      const targetSocket = target && io.sockets.sockets.get(target.socketId);
      targetSocket?.emit('file-cancelled', { id: msgId, from: myPeerId });
    }
    callback?.({ success: true });
  });

  // ── Send Encrypted File ──────────────────────────────────
  socket.on('send-file', ({ roomId, cipher, nonce, metadata, ttl }, callback) => {
    if (isRateLimited(ip, 30)) {
      return callback?.({ error: 'Rate limited.' });
    }

    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return callback?.({ error: 'Not registered.' });

    const room = rooms.get(roomId);
    if (!room) return callback?.({ error: 'Room not found.' });

    if (!room.members.has(myPeerId)) {
      return callback?.({ error: 'Not a member of this room.' });
    }

    // Validate metadata before relaying the encrypted payload.
    if (
      !metadata ||
      typeof metadata.name !== 'string' ||
      metadata.name.trim().length === 0 ||
      metadata.name.length > 160 ||
      !Number.isFinite(Number(metadata.size)) ||
      Number(metadata.size) < 0
    ) {
      return callback?.({ error: 'Invalid file metadata.' });
    }

    const fileSize = Math.floor(Number(metadata.size));
    if (fileSize > MAX_FILE_SIZE) {
      return callback?.({ error: `File too large. Max ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB.` });
    }

    if (metadata.mimeType !== undefined && (
      typeof metadata.mimeType !== 'string' || metadata.mimeType.length > 120
    )) {
      return callback?.({ error: 'Invalid file type.' });
    }

    const msgId = generateMessageId();

    const fileMessage = {
      id: msgId,
      from: myPeerId,
      cipher,
      nonce,
      metadata: { ...metadata, size: fileSize },
       ttl: normalizeMessageTtl(ttl, 30000),
      timestamp: Date.now(),
    };

    // Broadcast to all other members
    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      if (target) {
        const ts = io.sockets.sockets.get(target.socketId);
        if (ts) {
          ts.emit('file', fileMessage);
        }
      }
    }

    callback?.({ success: true, msgId });
  });

  // ── Typing Indicator ───────────────────────────────────────
  socket.on('typing', ({ roomId, isTyping }) => {
    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Broadcast to all other members
    for (const [pid] of room.members) {
      if (pid === myPeerId) continue;
      const target = peers.get(pid);
      if (target) {
        const ts = io.sockets.sockets.get(target.socketId);
        if (ts) ts.emit('typing', { peerId: myPeerId, isTyping });
      }
    }
  });

  // ── Call Signaling ─────────────────────────────────────────
  socket.on('call-signal', ({ roomId, targetPeerId, signal }) => {
    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (!room.members.has(myPeerId) || !room.members.has(targetPeerId)) return;
    if (!signal || typeof signal.type !== 'string' || signal.type.length > 32) return;

    const target = peers.get(targetPeerId);
    if (target) {
      const ts = io.sockets.sockets.get(target.socketId);
      if (ts) {
        ts.emit('call-signal', {
          roomId,
          fromPeerId: myPeerId,
          signal,
        });
      }
    }
  });

  // ── Group Room Controls ────────────────────────────────────
  socket.on('remove-room-member', ({ roomId, targetPeerId }, callback) => {
    if (isRateLimited(ip, 30)) return callback?.({ error: 'Rate limited.' });

    const myPeerId = socketToPeer.get(socket.id);
    const room = rooms.get(roomId);
    if (!myPeerId || !room) return callback?.({ error: 'Room not found.' });
    if (!room.isGroup || room.host !== myPeerId) return callback?.({ error: 'Only the room host can remove members.' });
    if (!targetPeerId || targetPeerId === myPeerId || !room.members.has(targetPeerId)) {
      return callback?.({ error: 'Room member not found.' });
    }

    room.members.delete(targetPeerId);
    pendingMessages.delete(targetPeerId);
    for (const [transferId, transfer] of fileTransfers) {
      if (transfer.roomId === roomId && transfer.from === targetPeerId) fileTransfers.delete(transferId);
    }

    const target = peers.get(targetPeerId);
    const targetSocket = target && io.sockets.sockets.get(target.socketId);
    if (target) target.connectedTo = null;
    targetSocket?.leave(roomId);
    targetSocket?.emit('room-member-removed', { roomId, peerId: targetPeerId });

    for (const [pid] of room.members) {
      const member = peers.get(pid);
      const memberSocket = member && io.sockets.sockets.get(member.socketId);
      memberSocket?.emit('peer-left', {
        roomId,
        peerId: targetPeerId,
        memberCount: room.members.size,
        reason: 'removed',
      });
    }

    callback?.({ success: true, memberCount: room.members.size });
  });

  socket.on('close-room', ({ roomId }, callback) => {
    if (isRateLimited(ip, 15)) return callback?.({ error: 'Rate limited.' });

    const myPeerId = socketToPeer.get(socket.id);
    const room = rooms.get(roomId);
    if (!myPeerId || !room) return callback?.({ error: 'Room not found.' });
    if (!room.isGroup || room.host !== myPeerId) return callback?.({ error: 'Only the room host can close this room.' });

    for (const [pid] of room.members) {
      pendingMessages.delete(pid);
      const member = peers.get(pid);
      if (member) member.connectedTo = null;
      const memberSocket = member && io.sockets.sockets.get(member.socketId);
      memberSocket?.leave(roomId);
      if (pid !== myPeerId) memberSocket?.emit('room-closed', { roomId });
    }

    for (const [transferId, transfer] of fileTransfers) {
      if (transfer.roomId === roomId) fileTransfers.delete(transferId);
    }
    if (room.roomCode) roomCodes.delete(room.roomCode);
    rooms.delete(roomId);
    callback?.({ success: true });
  });

  // ── Disconnect Room ────────────────────────────────────────
  socket.on('leave-room', ({ roomId }) => {
    const myPeerId = socketToPeer.get(socket.id);
    if (!myPeerId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Remove this peer from room
    room.members.delete(myPeerId);
    socket.leave(roomId);

    const myPeer = peers.get(myPeerId);
    if (myPeer) myPeer.connectedTo = null;

    pendingMessages.delete(myPeerId);
    for (const [transferId, transfer] of fileTransfers) {
      if (transfer.from === myPeerId) fileTransfers.delete(transferId);
    }

    if (room.isGroup) {
      // Notify remaining members
      for (const [pid] of room.members) {
        const p = peers.get(pid);
        if (p) {
          const ps = io.sockets.sockets.get(p.socketId);
          if (ps) {
            ps.emit('peer-left', {
              roomId,
              peerId: myPeerId,
              memberCount: room.members.size,
            });
          }
        }
      }

      // If room is empty, clean up
      if (room.members.size === 0) {
        if (room.roomCode) roomCodes.delete(room.roomCode);
        rooms.delete(roomId);
      } else if (room.host === myPeerId) {
        // Transfer host to first remaining member
        const newHost = room.members.keys().next().value;
        room.host = newHost;
        const hostPeer = peers.get(newHost);
        if (hostPeer) {
          const hs = io.sockets.sockets.get(hostPeer.socketId);
          if (hs) hs.emit('host-changed', { roomId, newHost });
        }
      }
    } else {
      // 1:1 room — notify the other peer and clean up
      for (const [pid] of room.members) {
        const otherPeer = peers.get(pid);
        if (otherPeer) {
          otherPeer.connectedTo = null;
          const os = io.sockets.sockets.get(otherPeer.socketId);
          if (os) os.emit('peer-disconnected', { peerId: myPeerId });
        }
        pendingMessages.delete(pid);
      }
      rooms.delete(roomId);
    }
  });

  // ── Socket Disconnect ──────────────────────────────────────
  socket.on('disconnect', () => {
    const peerId = socketToPeer.get(socket.id);
    if (!peerId) return;

    // Clean up all rooms this peer is in
    for (const [roomId, room] of rooms) {
      if (!room.members.has(peerId)) continue;

      room.members.delete(peerId);

      if (room.isGroup) {
        // Notify remaining members
        for (const [pid] of room.members) {
          const p = peers.get(pid);
          if (p) {
            const ps = io.sockets.sockets.get(p.socketId);
            if (ps) {
              ps.emit('peer-left', {
                roomId,
                peerId,
                memberCount: room.members.size,
              });
            }
          }
        }

        if (room.members.size === 0) {
          if (room.roomCode) roomCodes.delete(room.roomCode);
          rooms.delete(roomId);
        } else if (room.host === peerId) {
          const newHost = room.members.keys().next().value;
          room.host = newHost;
          const hostPeer = peers.get(newHost);
          if (hostPeer) {
            const hs = io.sockets.sockets.get(hostPeer.socketId);
            if (hs) hs.emit('host-changed', { roomId, newHost });
          }
        }
      } else {
        // 1:1 room
        for (const [pid] of room.members) {
          const otherPeer = peers.get(pid);
          if (otherPeer) {
            otherPeer.connectedTo = null;
            const os = io.sockets.sockets.get(otherPeer.socketId);
            if (os) os.emit('peer-disconnected', { peerId });
          }
        }
        rooms.delete(roomId);
      }
    }

    peers.delete(peerId);
    socketToPeer.delete(socket.id);
    pendingMessages.delete(peerId);
    for (const [token, invite] of invites) {
      if (invite.createdBy === peerId) invites.delete(token);
    }
    for (const [transferId, transfer] of fileTransfers) {
      if (transfer.from === peerId) fileTransfers.delete(transferId);
    }
    console.log(`[-] Peer disconnected: ${peerId.slice(0, 6)}...`);
  });
});

// ── Start Server ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`\n  ██████╗ ██╗████████╗███╗   ███╗ █████╗ ███████╗██╗  ██╗`);
  console.log(`  ██╔══██╗██║╚══██╔══╝████╗ ████║██╔══██╗██╔════╝██║ ██╔╝`);
  console.log(`  ██████╔╝██║   ██║   ██╔████╔██║███████║███████╗█████╔╝ `);
  console.log(`  ██╔══██╗██║   ██║   ██║╚██╔╝██║██╔══██║╚════██║██╔═██╗ `);
  console.log(`  ██████╔╝██║   ██║   ██║ ╚═╝ ██║██║  ██║███████║██║  ██╗`);
  console.log(`  ╚═════╝ ╚═╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝`);
  console.log(`\n  Anonymous encrypted chat running on port ${PORT}`);
  console.log(`  → http://localhost:${PORT}\n`);
});
