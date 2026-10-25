// ─────────────────────────────────────────────────────────────
//  BitMask — Socket.io Client Wrapper
// ─────────────────────────────────────────────────────────────

const BitMaskSocket = (() => {
  let socket = null;
  let handlers = {};
  let registeredPeerId = null;
  let manuallyDisconnected = false;
  let hasConnectedBefore = false;

  function connect() {
    if (socket?.connected || socket?.active) return;

    manuallyDisconnected = false;

    const serverUrl = window.BitMaskConfig?.serverUrl || (
      window.BitMaskConfig?.isNative ? '' : window.location.origin
    );
    if (!serverUrl) {
      handlers.onError?.('Mobile relay URL is not configured. Set BITMASK_SERVER_URL before building the APK.');
      return;
    }

    socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.25,
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      handlers.onReconnecting?.(attempt);
    });

    socket.io.on('reconnect_error', (err) => {
      handlers.onReconnectError?.(err?.message || 'Reconnect attempt failed.');
    });

    socket.io.on('reconnect_failed', () => {
      handlers.onReconnectFailed?.();
    });

    socket.on('connect', () => {
      console.log('[BitMask] Connected to server');
      const reconnected = hasConnectedBefore;
      hasConnectedBefore = true;
      handlers.onConnect?.({ reconnected });
    });

    socket.on('disconnect', (reason) => {
      console.log('[BitMask] Disconnected:', reason);
      registeredPeerId = null;
      if (!manuallyDisconnected) handlers.onDisconnect?.(reason);
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

    socket.on('room-closed', (data) => {
      handlers.onRoomClosed?.(data);
    });

    socket.on('room-member-removed', (data) => {
      handlers.onRoomMemberRemoved?.(data);
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

    socket.on('file-cancelled', (data) => {
      handlers.onFileCancelled?.(data);
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
        if (res?.error) reject(new Error(res.error));
        else {
          registeredPeerId = peerId;
          resolve(res);
        }
      });
    });
  }

  function waitForReady(timeoutMs = 10000) {
    if (socket?.connected && registeredPeerId) return Promise.resolve();
    if (!socket) connect();

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (socket?.connected && registeredPeerId) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('Secure connection is still starting. Please try scanning again.'));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function connectToPeer(targetPeerId, inviteToken = null) {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      socket.emit('connect-to-peer', { targetPeerId, inviteToken }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  }

  function createRoom() {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      socket.emit('create-room', {}, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  }

  function createInvite(kind = 'peer', options = {}) {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      socket.emit('create-invite', {
        kind,
        roomId: options.roomId || null,
        ttlMs: options.ttlMs,
      }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  }

  function redeemInvite(token) {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      socket.emit('redeem-invite', { token }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  }

  function joinRoom(roomCode, inviteToken = null) {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      socket.emit('join-room', { roomCode, inviteToken }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
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

  function closeRoom(roomId) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('close-room', { roomId }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function removeRoomMember(roomId, targetPeerId) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('remove-room-member', { roomId, targetPeerId }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  function disconnect() {
    if (!socket) return;
    manuallyDisconnected = true;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    registeredPeerId = null;
    hasConnectedBefore = false;
    handlers = {};
  }

  function reconnect() {
    manuallyDisconnected = false;
    if (!socket) {
      connect();
      return;
    }
    socket.connect();
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

  function cancelFile(roomId, msgId) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Not connected'));
      socket.emit('send-file-cancel', { roomId, msgId }, (res) => {
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
    waitForReady,
    register,
    connectToPeer,
    createRoom,
    createInvite,
    redeemInvite,
    joinRoom,
    distributeKey,
    sendMessage,
    sendFile,
    startFile,
    sendFileChunk,
    completeFile,
    cancelFile,
    sendTyping,
    sendCallSignal,
    leaveRoom,
    closeRoom,
    removeRoomMember,
    disconnect,
    reconnect,
    ackMessage,
    on,
    isConnected,
    measureLatency,
  };
})();
