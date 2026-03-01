// ─────────────────────────────────────────────────────────────
//  BitMask — Socket.io Client Wrapper
// ─────────────────────────────────────────────────────────────

const BitMaskSocket = (() => {
  let socket = null;
  let handlers = {};

  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('[BitMask] Connected to server');
      handlers.onConnect?.();
    });

    socket.on('disconnect', (reason) => {
      console.log('[BitMask] Disconnected:', reason);
      handlers.onDisconnect?.(reason);
    });

    socket.on('message', (msg) => {
      handlers.onMessage?.(msg);
    });

    socket.on('peer-connected', (data) => {
      handlers.onPeerConnected?.(data);
    });

    socket.on('peer-disconnected', (data) => {
      handlers.onPeerDisconnected?.(data);
    });

    // ── Group Events ──
    socket.on('peer-joined', (data) => {
      handlers.onPeerJoined?.(data);
    });

    socket.on('peer-left', (data) => {
      handlers.onPeerLeft?.(data);
    });

    socket.on('group-key', (data) => {
      handlers.onGroupKey?.(data);
    });

    socket.on('host-changed', (data) => {
      handlers.onHostChanged?.(data);
    });

    socket.on('typing', (data) => {
      handlers.onTyping?.(data);
    });

    socket.on('file', (data) => {
      handlers.onFile?.(data);
    });

    socket.on('connect_error', (err) => {
      console.error('[BitMask] Connection error:', err.message);
      handlers.onError?.(err.message);
    });
  }

  function register(peerId, publicKey) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('register', { peerId, publicKey }, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function connectToPeer(targetPeerId) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('connect-to-peer', { targetPeerId }, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function createRoom() {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('create-room', {}, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function joinRoom(roomCode) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('join-room', { roomCode }, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function distributeKey(roomId, targetPeerId, encryptedKey, nonce) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('distribute-key', { roomId, targetPeerId, encryptedKey, nonce }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function sendMessage(roomId, cipher, nonce, ttl) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-message', { roomId, cipher, nonce, ttl }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function sendTyping(roomId, isTyping) {
    if (socket) socket.emit('typing', { roomId, isTyping });
  }

  function leaveRoom(roomId) {
    if (socket) socket.emit('leave-room', { roomId });
  }

  function ackMessage(msgId) {
    if (socket) socket.emit('message-ack', { msgId });
  }

  function sendFile(roomId, cipher, nonce, metadata, ttl) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-file', { roomId, cipher, nonce, metadata, ttl }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function on(event, handler) {
    handlers[event] = handler;
  }

  function isConnected() {
    return socket?.connected || false;
  }

  return {
    connect,
    register,
    connectToPeer,
    createRoom,
    joinRoom,
    distributeKey,
    sendMessage,
    sendFile,
    sendTyping,
    leaveRoom,
    ackMessage,
    on,
    isConnected,
  };
})();
