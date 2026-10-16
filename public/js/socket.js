// ─────────────────────────────────────────────────────────────
//  BitMask — Socket.io Client Wrapper
// ─────────────────────────────────────────────────────────────

const BitMaskSocket = (() => {
  let socket = null;
  let handlers = {};

  function connect() {
    if (socket?.connected || socket?.active) return;

    const serverUrl = window.BitMaskConfig?.serverUrl || (
      window.BitMaskConfig?.isNative ? '' : window.location.origin
    );
    if (!serverUrl) {
      handlers.onError?.('Mobile relay URL is not configured. Set BITMASK_SERVER_URL before building the APK.');
      return;
    }

    socket = io(serverUrl, { transports: ['websocket', 'polling'] });

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

    socket.on('file-start', (data) => {
      handlers.onFileStart?.(data);
    });

    socket.on('file-chunk', (data) => {
      handlers.onFileChunk?.(data);
    });

    socket.on('file-complete', (data) => {
      handlers.onFileComplete?.(data);
    });

    socket.on('call-signal', (data) => {
      handlers.onCallSignal?.(data);
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

  function disconnect() {
    if (!socket) return;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    handlers = {};
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

  function startFile(roomId, metadata, ttl, chunkCount) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-file-start', { roomId, metadata, ttl, chunkCount }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function sendFileChunk(roomId, msgId, index, cipher, nonce) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-file-chunk', { roomId, msgId, index, cipher, nonce }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function completeFile(roomId, msgId) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-file-complete', { roomId, msgId }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function measureLatency() {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error('Not connected'));
      const startedAt = performance.now();
      const timeout = setTimeout(() => reject(new Error('Latency check timed out')), 4000);
      socket.emit('connection-ping', null, () => {
        clearTimeout(timeout);
        resolve(Math.round(performance.now() - startedAt));
      });
    });
  }

  function sendCallSignal(roomId, targetPeerId, signal) {
    if (socket) socket.emit('call-signal', { roomId, targetPeerId, signal });
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
    startFile,
    sendFileChunk,
    completeFile,
    sendTyping,
    sendCallSignal,
    leaveRoom,
    disconnect,
    ackMessage,
    on,
    isConnected,
    measureLatency,
  };
})();
