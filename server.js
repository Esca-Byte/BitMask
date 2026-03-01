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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for file transfers
});

// ── Security Middleware ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
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
// Rate limiting for socket events per IP
const socketRateMap = new Map();

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

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of socketRateMap) {
    const fresh = timestamps.filter(t => now - t < 60000);
    if (fresh.length === 0) socketRateMap.delete(ip);
    else socketRateMap.set(ip, fresh);
  }
}, 300000);

// ── REST Endpoints ───────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', peers: peers.size, rooms: rooms.size });
});

// ── Socket.io Logic ──────────────────────────────────────────

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

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
  socket.on('connect-to-peer', ({ targetPeerId }, callback) => {
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
  socket.on('join-room', ({ roomCode: code }, callback) => {
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
      ttl: Math.min(Math.max(ttl || 5000, 5000), 86400000), // 5s – 24h
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

    // Validate metadata
    if (!metadata || !metadata.name || !metadata.size) {
      return callback?.({ error: 'Invalid file metadata.' });
    }

    if (metadata.size > 5 * 1024 * 1024) {
      return callback?.({ error: 'File too large. Max 5MB.' });
    }

    const msgId = generateMessageId();

    const fileMessage = {
      id: msgId,
      from: myPeerId,
      cipher,
      nonce,
      metadata,
      ttl: Math.min(Math.max(ttl || 30000, 5000), 86400000),
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
  console.log(`\n  🔒 Anonymous encrypted chat running on port ${PORT}`);
  console.log(`  → http://localhost:${PORT}\n`);
});
