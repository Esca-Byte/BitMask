// ─────────────────────────────────────────────────────────────
//  BitMask — Main Application Controller
// ─────────────────────────────────────────────────────────────

const BitMaskApp = (() => {
  // ── State ──────────────────────────────────────────────────
  let peerId = null;
  let keyPair = null;
  let publicKeyBase64 = null;
  let sharedKey = null;
  let currentRoomId = null;
  let connectedPeerId = null;
  let messageTTL = 30000; // default 30s
  let typingTimeout = null;
  let isTypingSent = false;
  let messageTimers = new Map(); // msgId -> timer
  let messageRegistry = new Map(); // msgId -> { element, text, type }
  let mediaUrls = new Map(); // msgId -> local blob URL
  let activeViewOnceCleanup = null;
  let activeViewOnceMsgId = null;
  let incomingFileTransfers = new Map();
  let replyTarget = null;
  let qualityInterval = null;
  let qrScannerStream = null;
  let qrScannerFrame = null;
  let qrDetector = null;
  let qrScanBusy = false;

  // ── Group State ────────────────────────────────────────────
  let isGroupChat = false;
  let groupKey = null;          // AES-256 CryptoKey for group encryption
  let roomCode = null;          // 6-char room code
  let isHost = false;
  let groupMembers = new Map(); // peerId -> { publicKey }
  let typingPeers = new Set();  // peer IDs currently typing

  // ── New Features State ─────────────────────────────────────
  let isViewOnceActive = false;

  // ── DOM References ─────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ══════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════

  async function init() {
    // 1. Check if identity is locked with a passphrase
    if (BitMaskIdentity.isLocked()) {
      showUnlockView();
      setupUnlockHandlers();
      return; // Don't proceed until unlocked
    }

    // 2. Try to load saved identity (localStorage or sessionStorage)
    const saved = await BitMaskIdentity.load();

    if (saved) {
      peerId = saved.peerId;
      keyPair = saved.keyPair;
      publicKeyBase64 = saved.publicKeyBase64;
    } else {
      // Generate fresh identity
      await generateNewIdentity(false);
    }

    // 3. Sync UI state
    updatePeerIdDisplay();
    syncSoundToggle();
    syncRememberMeToggle();

    // 4. Set up event handlers
    setupSocketHandlers();
    setupUIHandlers();
    setupModalHandlers();
    setupFileHandlers();

    // 5. Connect to server
    BitMaskSocket.connect();

    // Show landing
    showView('landing-view');
    registerServiceWorker();
  }

  async function generateNewIdentity(reRegister = true) {
    peerId = BitMaskCrypto.generatePeerId();
    keyPair = await BitMaskCrypto.generateKeyPair();
    publicKeyBase64 = await BitMaskCrypto.exportPublicKey(keyPair.publicKey);

    // Save identity
    await BitMaskIdentity.save(peerId, keyPair, publicKeyBase64);

    if (reRegister) {
      updatePeerIdDisplay();
      try {
        await BitMaskSocket.register(peerId, publicKeyBase64);
        showToast('New identity generated.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Offline caching is an enhancement; never block the chat if it is unavailable.
      console.info('[BitMask] Offline cache unavailable:', err.message);
    });
  }

  function updatePeerIdDisplay() {
    $('#peer-id-display').textContent = formatPeerId(peerId);
    $('#peer-id-raw').textContent = peerId;
  }

  // ══════════════════════════════════════════════════════════
  //  UNLOCK FLOW (Passphrase-locked identity)
  // ══════════════════════════════════════════════════════════

  function showUnlockView() {
    showView('unlock-view');
    const lockedId = BitMaskIdentity.getLockedPeerId();
    if (lockedId) {
      $('#locked-peer-id').textContent = formatPeerId(lockedId);
    }
  }

  function setupUnlockHandlers() {
    // Unlock form
    $('#unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const passphrase = $('#unlock-passphrase').value;
      if (!passphrase) return;

      try {
        const identity = await BitMaskIdentity.unlockWithPassphrase(passphrase);
        peerId = identity.peerId;
        keyPair = identity.keyPair;
        publicKeyBase64 = identity.publicKeyBase64;

        // Continue normal init
        updatePeerIdDisplay();
        syncSoundToggle();
        syncRememberMeToggle();
        setupSocketHandlers();
        setupUIHandlers();
        setupModalHandlers();
        setupFileHandlers();
        BitMaskSocket.connect();
        showView('landing-view');
        registerServiceWorker();
        showToast('Identity unlocked!', 'success');
        BitMaskSound.playConnect();
      } catch (err) {
        showToast('Wrong passphrase.', 'error');
        $('#unlock-passphrase').value = '';
        $('#unlock-passphrase').focus();
      }
    });

    // Skip → use new identity
    $('#unlock-skip-btn').addEventListener('click', async () => {
      BitMaskIdentity.removeLock();
      BitMaskIdentity.clear();
      await generateNewIdentity(false);
      updatePeerIdDisplay();
      syncSoundToggle();
      syncRememberMeToggle();
      setupSocketHandlers();
      setupUIHandlers();
      setupModalHandlers();
      setupFileHandlers();
      BitMaskSocket.connect();
      showView('landing-view');
      registerServiceWorker();
      showToast('Started with a fresh identity.', 'info');
    });
  }

  // ══════════════════════════════════════════════════════════
  //  SOCKET EVENT HANDLERS
  // ══════════════════════════════════════════════════════════

  function setupSocketHandlers() {
    BitMaskSocket.on('onConnect', async () => {
      updateStatus('online');
      updateChatSessionStatus('online');
      startQualityMonitor();
      try {
        await BitMaskSocket.register(peerId, publicKeyBase64);
        showToast('Identity secured. You are online.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    BitMaskSocket.on('onDisconnect', () => {
      updateStatus('offline');
      updateChatSessionStatus('offline');
      stopQualityMonitor();
      window.BitMaskCall?.handleTransportDisconnect();
      BitMaskSound.playDisconnect();
      showToast('Connection lost. Reconnecting...', 'warning');
    });

    // ── 1:1 Peer Connected (incoming connection) ──
    BitMaskSocket.on('onPeerConnected', async (data) => {
      try {
        const peerPubKey = await BitMaskCrypto.importPublicKey(data.peerPublicKey);
        sharedKey = await BitMaskCrypto.deriveSharedKey(keyPair.privateKey, peerPubKey);
        currentRoomId = data.roomId;
        connectedPeerId = data.peerId;
        isGroupChat = false;
        switchToChat(data.peerId);
        BitMaskSound.playConnect();
        showToast('Peer connected to you!', 'success');
      } catch (err) {
        showToast('Failed to establish encryption: ' + err.message, 'error');
      }
    });

    // ── 1:1 Peer Disconnected ──
    BitMaskSocket.on('onPeerDisconnected', () => {
      if (isGroupChat) return; // groups use peer-left
      window.BitMaskCall?.hangup(false);
      addSystemMessage('Peer disconnected. Messages self-destructing...');
      BitMaskSound.playDisconnect();
      destroyAllMessages();
      setTimeout(() => {
        switchToLanding();
        resetChatState();
      }, 2000);
    });

    // ── Group: Peer Joined ──
    BitMaskSocket.on('onPeerJoined', async (data) => {
      if (!isGroupChat || data.roomId !== currentRoomId) return;

      groupMembers.set(data.peerId, { publicKey: data.publicKey });
      updateMemberCount(data.memberCount);
      addSystemMessage(`${data.peerId.slice(0, 8)}... joined the room.`);
      BitMaskSound.playConnect();

      // If I'm the host, distribute the group key to the new peer
      if (isHost && groupKey) {
        try {
          const peerPubKey = await BitMaskCrypto.importPublicKey(data.publicKey);
          const pairwiseKey = await BitMaskCrypto.deriveSharedKey(keyPair.privateKey, peerPubKey);
          const rawGroupKey = await BitMaskCrypto.exportRawKey(groupKey);
          const { cipher, nonce } = await BitMaskCrypto.encrypt(pairwiseKey, rawGroupKey);
          await BitMaskSocket.distributeKey(currentRoomId, data.peerId, cipher, nonce);
          console.log('[BitMask] Group key distributed to', data.peerId.slice(0, 8));
        } catch (err) {
          console.error('[BitMask] Failed to distribute group key:', err);
        }
      }
    });

    // ── Group: Peer Left ──
    BitMaskSocket.on('onPeerLeft', (data) => {
      if (!isGroupChat || data.roomId !== currentRoomId) return;

      groupMembers.delete(data.peerId);
      typingPeers.delete(data.peerId);
      updateTypingIndicator();
      updateMemberCount(data.memberCount);
      addSystemMessage(`${data.peerId.slice(0, 8)}... left the room.`);
      BitMaskSound.playDisconnect();
    });

    // ── Group: Receive Group Key ──
    BitMaskSocket.on('onGroupKey', async (data) => {
      if (data.roomId !== currentRoomId) return;
      try {
        const hostPubKey = await BitMaskCrypto.importPublicKey(data.fromPublicKey);
        const pairwiseKey = await BitMaskCrypto.deriveSharedKey(keyPair.privateKey, hostPubKey);
        const rawKeyBase64 = await BitMaskCrypto.decrypt(pairwiseKey, data.encryptedKey, data.nonce);
        groupKey = await BitMaskCrypto.importRawKey(rawKeyBase64);
        addSystemMessage('Encrypted group session established.');
        console.log('[BitMask] Group key received from host');
      } catch (err) {
        console.error('[BitMask] Failed to decrypt group key:', err);
        showToast('Failed to establish group encryption.', 'error');
      }
    });

    // ── Group: Host Changed ──
    BitMaskSocket.on('onHostChanged', (data) => {
      if (data.roomId !== currentRoomId) return;
      isHost = (data.newHost === peerId);
      if (isHost) {
        addSystemMessage('You are now the room host.');
      }
    });

    // ── Incoming Message ──
    BitMaskSocket.on('onMessage', async (msg) => {
      const key = isGroupChat ? groupKey : sharedKey;
      if (!key) return;
      try {
        const plaintext = await BitMaskCrypto.decrypt(key, msg.cipher, msg.nonce);
        BitMaskSocket.ackMessage(msg.id);
        const payload = decodeMessagePayload(plaintext);
        if (payload.kind === 'reaction') {
          applyReaction(payload.targetId, payload.label, msg.ttl);
        } else {
          renderMessage(msg.id, payload.text, 'incoming', msg.ttl, isGroupChat ? msg.from : null, payload.replyTo);
          BitMaskSound.playIncoming();
        }
      } catch (err) {
        console.error('Decryption failed:', err);
        renderMessage(msg.id, '[Decryption failed]', 'incoming error', msg.ttl, isGroupChat ? msg.from : null);
      }
    });

    BitMaskSocket.on('onFileStart', (data) => {
      const metadata = normalizeFileMetadata(data.metadata);
      const chunkCount = Number(data.chunkCount);
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 128) return;
      const timeoutId = setTimeout(() => incomingFileTransfers.delete(data.id), Math.max(5000, Number(data.ttl) || messageTTL));
      incomingFileTransfers.set(data.id, {
        metadata,
        ttl: data.ttl,
        from: data.from,
        chunkCount,
        chunks: new Array(chunkCount),
        received: 0,
        timeoutId,
      });
    });

    BitMaskSocket.on('onFileChunk', (data) => {
      const transfer = incomingFileTransfers.get(data.id);
      if (!transfer || !Number.isInteger(Number(data.index))) return;
      const index = Number(data.index);
      if (index < 0 || index >= transfer.chunkCount || transfer.chunks[index]) return;
      transfer.chunks[index] = { cipher: data.cipher, nonce: data.nonce };
      transfer.received += 1;
    });

    BitMaskSocket.on('onFileComplete', async (data) => {
      const transfer = incomingFileTransfers.get(data.id);
      if (!transfer) return;
      clearTimeout(transfer.timeoutId);
      incomingFileTransfers.delete(data.id);

      const key = isGroupChat ? groupKey : sharedKey;
      if (!key || transfer.received !== transfer.chunkCount || transfer.chunks.some(chunk => !chunk)) {
        addSystemMessage('Encrypted media arrived incomplete and was discarded.');
        return;
      }

      try {
        const decrypted = await BitMaskCrypto.decryptFileChunks(key, transfer.chunks);
        const blob = new Blob([decrypted], { type: transfer.metadata.mimeType });
        const url = URL.createObjectURL(blob);
        renderFileMessage(data.id, transfer.metadata, url, 'incoming', transfer.ttl, isGroupChat ? transfer.from : null);
        BitMaskSound.playIncoming();
      } catch (err) {
        console.error('Chunked file decryption failed:', err);
        addSystemMessage('Failed to decrypt incoming media.');
      }
    });

    // ── Incoming File ──
    BitMaskSocket.on('onFile', async (data) => {
      const key = isGroupChat ? groupKey : sharedKey;
      if (!key) return;
      try {
        const decrypted = await BitMaskCrypto.decryptFile(key, data.cipher, data.nonce);
        const metadata = normalizeFileMetadata(data.metadata);
        const mime = metadata.mimeType || 'application/octet-stream';
        const blob = new Blob([decrypted], { type: mime });
        const url = URL.createObjectURL(blob);
        renderFileMessage(data.id, metadata, url, 'incoming', data.ttl, isGroupChat ? data.from : null);
        BitMaskSound.playIncoming();
      } catch (err) {
        console.error('File decryption failed:', err);
        addSystemMessage('Failed to decrypt incoming file.');
      }
    });

    // ── Typing Indicator ──
    BitMaskSocket.on('onTyping', ({ peerId: typerId, isTyping }) => {
      if (isGroupChat) {
        if (isTyping) typingPeers.add(typerId);
        else typingPeers.delete(typerId);
        updateTypingIndicator();
      } else {
        const indicator = $('#typing-indicator');
        if (isTyping) {
          indicator.classList.add('visible');
        } else {
          indicator.classList.remove('visible');
        }
      }
    });

    BitMaskSocket.on('onError', (msg) => {
      showToast(msg, 'error');
    });

    // ── Call Signaling Relay ──
    BitMaskSocket.on('onCallSignal', ({ roomId, fromPeerId, signal }) => {
      if (signal.type === 'offer-request') {
        window.BitMaskCall.handleIncomingCallRequest(roomId, fromPeerId, signal);
      } else {
        window.BitMaskCall.handleIncomingSignal(fromPeerId, signal);
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  //  UI EVENT HANDLERS
  // ══════════════════════════════════════════════════════════

  function setupUIHandlers() {
    // ── Copy Peer ID ──
    $('#copy-id-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(peerId).then(() => {
        showToast('Peer ID copied!', 'success');
        const btn = $('#copy-id-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy ID', 1500);
      });
    });

    // ── QR Code ──
    $('#qr-btn').addEventListener('click', () => {
      const svg = BitMaskQR.toSVG(peerId, {
        size: 360,
        margin: 4,
        darkColor: '#07111f',
        lightColor: '#ffffff',
      });
      $('#qr-container').innerHTML = svg;
      $('#qr-peer-id').textContent = formatPeerId(peerId);
      openModal('qr-modal');
    });

    // ── QR Copy Button ──
    $('#qr-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(peerId).then(() => {
        const btn = $('#qr-copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy peer ID', 1500);
      });
    });

    // ── QR scanner ──
    $('#scan-qr-btn').addEventListener('click', () => {
      openQrScanner();
    });

    // ── Sound Toggle ──
    $('#sound-toggle-btn').addEventListener('click', () => {
      const enabled = BitMaskSound.isEnabled();
      BitMaskSound.setEnabled(!enabled);
      syncSoundToggle();
      showToast(enabled ? 'Sounds off' : 'Sounds on', 'info');
    });

    // ── Remember Me Toggle ──
    $('#remember-me-toggle').addEventListener('change', async (e) => {
      if (e.target.checked) {
        await BitMaskIdentity.enablePersistence(peerId, keyPair, publicKeyBase64);
        showToast('Identity will persist across sessions.', 'success');
      } else {
        BitMaskIdentity.disablePersistence(peerId, keyPair, publicKeyBase64);
        showToast('Identity will be forgotten when you close the tab.', 'info');
      }
    });

    // ── Connect to peer (1:1) ──
    $('#connect-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#target-peer-input');
      const targetId = input.value.replace(/[\s\-]/g, '').toUpperCase();

      if (targetId.length !== 16) {
        showToast('Peer ID must be 16 characters.', 'error');
        return;
      }

      if (targetId === peerId) {
        showToast('You cannot connect to yourself.', 'error');
        return;
      }

      const btn = $('#connect-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Connecting...';

      try {
        const res = await BitMaskSocket.connectToPeer(targetId);
        const peerPubKey = await BitMaskCrypto.importPublicKey(res.peerPublicKey);
        sharedKey = await BitMaskCrypto.deriveSharedKey(keyPair.privateKey, peerPubKey);
        currentRoomId = res.roomId;
        connectedPeerId = targetId;
        isGroupChat = false;
        switchToChat(targetId);
        BitMaskSound.playConnect();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Connect';
      }
    });

    // ── Create Group Room ──
    $('#create-group-btn').addEventListener('click', async () => {
      const btn = $('#create-group-btn');
      btn.disabled = true;

      try {
        // Generate group encryption key
        groupKey = await BitMaskCrypto.generateGroupKey();
        const res = await BitMaskSocket.createRoom();
        currentRoomId = res.roomId;
        roomCode = res.roomCode;
        isGroupChat = true;
        isHost = true;
        groupMembers.clear();
        groupMembers.set(peerId, { publicKey: publicKeyBase64 });

        // Show room created modal
        $('#room-code-display').textContent = roomCode;
        openModal('room-created-modal');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // ── Enter Room (from created modal) ──
    $('#enter-room-btn').addEventListener('click', () => {
      closeModal('room-created-modal');
      switchToGroupChat();
    });

    // ── Copy Room Code (modal) ──
    $('#copy-room-code-modal-btn').addEventListener('click', () => {
      if (roomCode) {
        navigator.clipboard.writeText(roomCode).then(() => {
          const btn = $('#copy-room-code-modal-btn');
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy Code', 1500);
        });
      }
    });

    // ── Join Group Room ──
    $('#join-group-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#room-code-input');
      const code = input.value.trim().toUpperCase();

      if (code.length !== 6) {
        showToast('Room code must be 6 characters.', 'error');
        return;
      }

      const btn = $('#join-group-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Joining...';

      try {
        const res = await BitMaskSocket.joinRoom(code);
        currentRoomId = res.roomId;
        roomCode = res.roomCode;
        isGroupChat = true;
        isHost = false;
        groupMembers.clear();

        // Store existing members
        for (const m of res.members) {
          groupMembers.set(m.peerId, { publicKey: m.publicKey });
        }
        groupMembers.set(peerId, { publicKey: publicKeyBase64 });

        switchToGroupChat();
        BitMaskSound.playConnect();
        showToast('Joined group room!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Join';
      }
    });

    // ── Send message ──
    $('#chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#message-input');
      const text = input.value.trim();
      if (!text || !currentRoomId) return;

      const key = isGroupChat ? groupKey : sharedKey;
      if (!key) {
        showToast('Encryption key not ready. Wait a moment.', 'warning');
        return;
      }

      input.value = '';
      input.style.height = 'auto';
      input.focus();
      cancelTyping();

      try {
        const payload = {
          kind: 'text',
          text,
          replyTo: replyTarget ? {
            id: replyTarget.id,
            preview: replyTarget.preview,
          } : null,
        };
        const { cipher, nonce } = await BitMaskCrypto.encrypt(key, JSON.stringify(payload));
        const res = await BitMaskSocket.sendMessage(currentRoomId, cipher, nonce, messageTTL);
        renderMessage(res.msgId, text, 'outgoing', messageTTL, null, payload.replyTo);
        clearReplyTarget();
        BitMaskSound.playOutgoing();
      } catch (err) {
        showToast('Failed to send: ' + err.message, 'error');
      }
    });

    $('#cancel-reply-btn').addEventListener('click', clearReplyTarget);

    $('#messages-container').addEventListener('click', (event) => {
      const action = event.target.closest('[data-message-action]');
      if (!action) return;
      const messageId = action.closest('.message')?.dataset.messageId;
      if (!messageId) return;

      if (action.dataset.messageAction === 'reply') {
        beginReply(messageId);
      } else if (action.dataset.messageAction === 'reaction') {
        sendReaction(messageId, action.dataset.reaction);
      }
    });

    // ── Keyboard & Typing indicator ──
    $('#message-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    $('#message-input').addEventListener('input', () => {
      autoResizeInput();
      if (!currentRoomId) return;
      if (!isTypingSent) {
        BitMaskSocket.sendTyping(currentRoomId, true);
        isTypingSent = true;
      }
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(cancelTyping, 2000);
    });

    // ── TTL selector ──
    $$('.ttl-option').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.ttl-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        messageTTL = parseInt(btn.dataset.ttl);
        showToast(`Messages self-destruct in ${btn.textContent}`, 'info');
      });
    });

    // ── Leave / Disconnect ──
    $('#leave-btn').addEventListener('click', () => {
      if (currentRoomId) {
        BitMaskSocket.leaveRoom(currentRoomId);
        destroyAllMessages();
        switchToLanding();
        resetChatState();
      }
    });

    // ── Copy Room Code & Invite Link (chat header) ──
    $('#copy-room-code-btn').addEventListener('click', () => {
      if (roomCode) {
        const inviteUrl = `${window.location.origin}/#room=${roomCode}`;
        navigator.clipboard.writeText(inviteUrl).then(() => {
          showToast('Shareable room link copied to clipboard!', 'success');
        });
      }
    });

    // ── Panic Button ──
    $('#panic-btn').addEventListener('click', () => {
      if (confirm('Emergency wipe: erase keys, storage, and exit immediately?')) {
        BitMaskPanic.trigger();
      }
    });

    // ── Stealth Blur (Focus Loss Protection) ──
    window.addEventListener('blur', () => {
      const container = $('#messages-container');
      if (container) container.classList.add('stealth-blur');
    });

    window.addEventListener('focus', () => {
      const container = $('#messages-container');
      if (container) container.classList.remove('stealth-blur');
    });

    // ── View Members ──
    $('#member-count-btn').addEventListener('click', () => {
      renderMembersList();
      openModal('members-modal');
    });

    // ── New Identity ──
    $('#new-identity-btn').addEventListener('click', async () => {
      BitMaskIdentity.clear();
      await generateNewIdentity(true);
      syncRememberMeToggle();
    });

    // ── E2EE WebRTC Voice & Video Call Handlers ──
    $('#audio-call-btn').addEventListener('click', () => {
      if (currentRoomId && connectedPeerId) {
        window.BitMaskCall.startCall(currentRoomId, connectedPeerId, 'voice');
      }
    });

    $('#video-call-btn').addEventListener('click', () => {
      if (currentRoomId && connectedPeerId) {
        window.BitMaskCall.startCall(currentRoomId, connectedPeerId, 'video');
      }
    });

    $('#incoming-accept-btn').addEventListener('click', () => {
      window.BitMaskCall.acceptIncomingCall();
    });

    $('#incoming-reject-btn').addEventListener('click', () => {
      window.BitMaskCall.rejectIncomingCall();
    });

    $('#call-mute-audio-btn').addEventListener('click', () => {
      window.BitMaskCall.toggleMute();
    });

    $('#call-toggle-video-btn').addEventListener('click', () => {
      window.BitMaskCall.toggleCamera();
    });

    $('#call-hangup-btn').addEventListener('click', () => {
      window.BitMaskCall.hangup();
    });
  }

  // ══════════════════════════════════════════════════════════
  //  MODAL HANDLERS (Export / Import / Lock)
  // ══════════════════════════════════════════════════════════

  function setupModalHandlers() {
    // ── Close modals via backdrop / X button ──
    $$('.modal-backdrop').forEach(bd => {
      bd.addEventListener('click', () => {
        const modal = bd.closest('.modal');
        if (modal?.id === 'media-preview-modal') closeMediaPreview();
        else if (modal?.id === 'qr-scanner-modal') closeQrScannerModal();
        else if (modal) closeModal(modal.id);
      });
    });
    $$('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal?.id === 'media-preview-modal') closeMediaPreview();
        else if (modal?.id === 'qr-scanner-modal') closeQrScannerModal();
        else if (modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const mediaPreview = $('#media-preview-modal');
      if (mediaPreview && !mediaPreview.classList.contains('hidden')) {
        closeMediaPreview();
        return;
      }
      const scanner = $('#qr-scanner-modal');
      if (scanner && !scanner.classList.contains('hidden')) {
        closeQrScannerModal();
        return;
      }
      const openModalEl = $('.modal:not(.hidden)');
      if (openModalEl) closeModal(openModalEl.id);
    });

    // ── Open Export Modal ──
    $('#export-id-btn').addEventListener('click', () => {
      $('#export-passphrase').value = '';
      $('#export-passphrase-confirm').value = '';
      openModal('export-modal');
    });

    // ── Export Identity ──
    $('#export-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = $('#export-passphrase').value;
      const confirm = $('#export-passphrase-confirm').value;

      if (pass && pass !== confirm) {
        showToast('Passphrases do not match.', 'error');
        return;
      }

      try {
        await BitMaskIdentity.exportIdentity(peerId, keyPair, publicKeyBase64, pass || null);
        closeModal('export-modal');
        showToast('Identity exported!', 'success');
      } catch (err) {
        showToast('Export failed: ' + err.message, 'error');
      }
    });

    // ── Open Import Modal ──
    $('#import-id-btn').addEventListener('click', () => {
      $('#import-passphrase').value = '';
      importFileData = null;
      const submitBtn = $('#import-form').querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const zone = $('#import-drop-zone');
      zone.classList.remove('has-file');
      zone.querySelector('span').textContent = 'Drop .bitmask file here or click to browse';
      openModal('import-modal');
    });

    // ── File drop zone ──
    let importFileData = null;

    const dropZone = $('#import-drop-zone');
    const fileInput = $('#import-file-input');

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleImportFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) handleImportFile(fileInput.files[0]);
    });

    function handleImportFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        importFileData = reader.result;
        dropZone.classList.add('has-file');
        dropZone.querySelector('span').textContent = file.name;
        const submitBtn = $('#import-form').querySelector('button[type="submit"]');
        submitBtn.disabled = false;
      };
      reader.readAsText(file);
    }

    // ── Import Identity ──
    $('#import-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!importFileData) return;

      const pass = $('#import-passphrase').value || null;

      try {
        const identity = await BitMaskIdentity.importIdentity(importFileData, pass);
        peerId = identity.peerId;
        keyPair = identity.keyPair;
        publicKeyBase64 = identity.publicKeyBase64;

        // Save & re-register
        await BitMaskIdentity.save(peerId, keyPair, publicKeyBase64);
        updatePeerIdDisplay();
        await BitMaskSocket.register(peerId, publicKeyBase64);

        closeModal('import-modal');
        showToast('Identity imported!', 'success');
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
    });

    // ── Open Lock Modal ──
    $('#lock-id-btn').addEventListener('click', () => {
      if (BitMaskIdentity.isLocked()) {
        // Offer to remove lock
        BitMaskIdentity.removeLock();
        showToast('Passphrase lock removed.', 'info');
        return;
      }
      if (!BitMaskIdentity.isPersistent()) {
        showToast('Enable "Remember Identity" first to use passphrase lock.', 'warning');
        return;
      }
      $('#lock-passphrase').value = '';
      $('#lock-passphrase-confirm').value = '';
      openModal('lock-modal');
    });

    // ── Lock Identity ──
    $('#lock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = $('#lock-passphrase').value;
      const confirm = $('#lock-passphrase-confirm').value;

      if (!pass || pass.length < 4) {
        showToast('Passphrase must be at least 4 characters.', 'error');
        return;
      }
      if (pass !== confirm) {
        showToast('Passphrases do not match.', 'error');
        return;
      }

      try {
        await BitMaskIdentity.lockWithPassphrase(peerId, keyPair, publicKeyBase64, pass);
        closeModal('lock-modal');
        showToast('Identity locked with passphrase!', 'success');
      } catch (err) {
        showToast('Failed to lock: ' + err.message, 'error');
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  //  FILE SHARING HANDLERS
  // ══════════════════════════════════════════════════════════

  function setupFileHandlers() {
    const fileInput = $('#file-input');
    const attachBtn = $('#file-attach-btn');
    const chatForm = $('#chat-form');
    const messageInput = $('#message-input');
    const MAX_SIZE = 25 * 1024 * 1024;
    const MAX_SOURCE_SIZE = 50 * 1024 * 1024;
    const CHUNK_SIZE = 512 * 1024;

    attachBtn.addEventListener('click', () => {
      const key = isGroupChat ? groupKey : sharedKey;
      if (!key || !currentRoomId) {
        showToast('Connect to a peer first.', 'warning');
        return;
      }
      fileInput.click();
    });

    // ── View Once Toggle Button ──
    $('#view-once-btn').addEventListener('click', () => {
      isViewOnceActive = !isViewOnceActive;
      $('#view-once-btn').classList.toggle('active', isViewOnceActive);
      showToast(
        isViewOnceActive ? 'View Once Mode ON (Media destroys after 1 view)' : 'View Once Mode OFF',
        isViewOnceActive ? 'info' : 'warning'
      );
    });

    async function sendFile(file) {
      if (!file) return;

      if (file.size > MAX_SOURCE_SIZE) {
        showToast('File too large. Maximum source size is 50MB.', 'error');
        return;
      }

      const key = isGroupChat ? groupKey : sharedKey;
      if (!key || !currentRoomId) {
        showToast('Encryption key not ready.', 'warning');
        return;
      }

      const sendingMsg = addSystemMessage(`Preparing ${file.name || 'file'}…`);
      try {
        const preparedFile = await prepareFileForSending(file, (message) => {
          if (sendingMsg?.parentNode) sendingMsg.textContent = message;
        });
        if (preparedFile.size > MAX_SIZE) {
          showToast('File is still larger than the 25MB transfer limit after optimization.', 'error');
          return;
        }
        const buffer = await preparedFile.arrayBuffer();
        const mimeType = preparedFile.type || guessMimeType(preparedFile.name);
        const canViewOnce = mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/');

        const metadata = {
          name: (preparedFile.name || 'untitled-file').slice(-120),
          mimeType,
          size: preparedFile.size,
          originalSize: file.size,
          optimized: preparedFile.size < file.size,
          viewOnce: isViewOnceActive && canViewOnce,
        };

        if (isViewOnceActive && !canViewOnce) {
          showToast('View Once is available for images, video, and audio.', 'warning');
        }

        // Reset view once mode state
        if (isViewOnceActive) {
          isViewOnceActive = false;
          $('#view-once-btn').classList.remove('active');
        }

        if (sendingMsg?.parentNode) sendingMsg.textContent = 'Encrypting media…';
        const encryptedChunks = await BitMaskCrypto.encryptFileChunks(
          key,
          buffer,
          CHUNK_SIZE,
          (completed, total) => {
            if (sendingMsg?.parentNode) sendingMsg.textContent = `Encrypting media · ${completed}/${total}`;
          }
        );
        const res = await BitMaskSocket.startFile(currentRoomId, metadata, messageTTL, encryptedChunks.length);

        for (let index = 0; index < encryptedChunks.length; index++) {
          await BitMaskSocket.sendFileChunk(
            currentRoomId,
            res.msgId,
            index,
            encryptedChunks[index].cipher,
            encryptedChunks[index].nonce,
          );
          if (sendingMsg?.parentNode) sendingMsg.textContent = `Sending media · ${index + 1}/${encryptedChunks.length}`;
        }
        await BitMaskSocket.completeFile(currentRoomId, res.msgId);

        // Render locally
        const blob = new Blob([buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        renderFileMessage(res.msgId, metadata, url, 'outgoing', messageTTL);
        BitMaskSound.playOutgoing();
      } catch (err) {
        showToast('Failed to send file: ' + err.message, 'error');
      } finally {
        if (sendingMsg && sendingMsg.parentNode) sendingMsg.remove();
      }
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = ''; // Reset so the same file can be sent again.
      await sendFile(file);
    });

    // Drop files directly on the composer.
    chatForm.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
        chatForm.classList.add('drop-ready');
      }
    });

    chatForm.addEventListener('dragleave', (event) => {
      if (!chatForm.contains(event.relatedTarget)) chatForm.classList.remove('drop-ready');
    });

    chatForm.addEventListener('drop', async (event) => {
      event.preventDefault();
      chatForm.classList.remove('drop-ready');
      const files = Array.from(event.dataTransfer?.files || []);
      for (const file of files.slice(0, 3)) await sendFile(file);
      if (files.length > 3) showToast('Only the first 3 dropped files were added.', 'info');
    });

    // Pasting a screenshot or copied image sends it as encrypted media.
    messageInput.addEventListener('paste', async (event) => {
      const image = Array.from(event.clipboardData?.files || [])
        .find(file => file.type.startsWith('image/'));
      if (!image) return;
      event.preventDefault();
      await sendFile(image);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  VIEW & CHAT MANAGEMENT
  // ══════════════════════════════════════════════════════════

  function showView(viewId) {
    $$('.view').forEach(v => v.classList.add('hidden'));
    $(`#${viewId}`).classList.remove('hidden');
  }

  function switchToChat(remotePeerId) {
    showView('chat-view');
    updateChatSessionStatus(BitMaskSocket.isConnected() ? 'online' : 'offline');
    messageRegistry.clear();
    clearIncomingFileTransfers();
    revokeAllMediaUrls();
    clearReplyTarget();
    // 1:1 mode
    $('#chat-direct-info').classList.remove('hidden');
    $('#chat-group-info').classList.add('hidden');
    $('#member-count-btn').classList.add('hidden');

    // Show Voice & Video Call Buttons
    $('#audio-call-btn').classList.remove('hidden');
    $('#video-call-btn').classList.remove('hidden');

    $('#connected-peer-id').textContent = formatPeerId(remotePeerId);
    $('#messages-container').innerHTML = `
      <div class="initial-session-banner">
        <div class="session-banner-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="session-banner-title">End-to-End Encrypted Session Established</div>
        <div class="session-banner-sub">Messages self-destruct after <span class="ttl-tag">${formatTTL(messageTTL)}</span></div>
      </div>
    `;
    $('#message-input').focus();
  }

  function switchToGroupChat() {
    showView('chat-view');
    updateChatSessionStatus(BitMaskSocket.isConnected() ? 'online' : 'offline');
    messageRegistry.clear();
    clearIncomingFileTransfers();
    revokeAllMediaUrls();
    clearReplyTarget();
    // Group mode
    $('#chat-direct-info').classList.add('hidden');
    $('#chat-group-info').classList.remove('hidden');
    $('#member-count-btn').classList.remove('hidden');

    // Hide Voice & Video Call Buttons
    $('#audio-call-btn').classList.add('hidden');
    $('#video-call-btn').classList.add('hidden');

    $('#group-room-code').textContent = roomCode;
    updateMemberCount(groupMembers.size);
    $('#messages-container').innerHTML = `
      <div class="initial-session-banner">
        <div class="session-banner-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="session-banner-title">Group Room Joined (${roomCode})</div>
        <div class="session-banner-sub">Share code <code>${roomCode}</code> to invite others · Self-destruct: <span class="ttl-tag">${formatTTL(messageTTL)}</span></div>
      </div>
    `;
    $('#message-input').focus();
  }

  function resetChatState() {
    window.BitMaskCall?.hangup(true);
    sharedKey = null;
    currentRoomId = null;
    connectedPeerId = null;
    isGroupChat = false;
    groupKey = null;
    roomCode = null;
    isHost = false;
    groupMembers.clear();
    typingPeers.clear();
  }

  function switchToLanding() {
    showView('landing-view');
    $('#target-peer-input').value = '';
    $('#room-code-input').value = '';
    $('#typing-indicator').classList.remove('visible');
  }

  // ══════════════════════════════════════════════════════════
  //  MESSAGE RENDERING
  // ══════════════════════════════════════════════════════════

  function clearInitialBanner() {
    const banner = $('#messages-container .initial-session-banner');
    if (banner) {
      banner.remove();
    }
  }

  function clearIncomingFileTransfers() {
    incomingFileTransfers.forEach(transfer => clearTimeout(transfer.timeoutId));
    incomingFileTransfers.clear();
  }

  function rememberMediaUrl(msgId, blobUrl) {
    mediaUrls.set(msgId, blobUrl);
  }

  function forgetMediaUrl(msgId) {
    const blobUrl = mediaUrls.get(msgId);
    if (!blobUrl) return;
    if (activeViewOnceMsgId === msgId) {
      activeViewOnceCleanup = null;
      activeViewOnceMsgId = null;
      closeModal('view-once-modal');
    }
    const previewMedia = $('#media-preview-container')?.querySelector('[src]');
    if (previewMedia?.src === blobUrl) closeMediaPreview();
    URL.revokeObjectURL(blobUrl);
    mediaUrls.delete(msgId);
  }

  function revokeAllMediaUrls() {
    mediaUrls.forEach((url) => URL.revokeObjectURL(url));
    mediaUrls.clear();
    closeMediaPreview();
  }

  function openMediaPreview(metadata, blobUrl) {
    const container = $('#media-preview-container');
    const meta = $('#media-preview-meta');
    if (!container || !meta) return;

    container.innerHTML = '';
    meta.textContent = `${metadata.name} · ${formatFileSize(metadata.size)}`;

    let mediaEl;
    if (metadata.mimeType.startsWith('image/')) {
      mediaEl = document.createElement('img');
      mediaEl.alt = metadata.name;
      mediaEl.decoding = 'async';
    } else if (metadata.mimeType.startsWith('video/')) {
      mediaEl = document.createElement('video');
      mediaEl.controls = true;
      mediaEl.autoplay = true;
      mediaEl.playsInline = true;
    } else if (metadata.mimeType.startsWith('audio/')) {
      mediaEl = document.createElement('audio');
      mediaEl.controls = true;
      mediaEl.autoplay = true;
    } else {
      mediaEl = document.createElement('div');
      mediaEl.className = 'message-content';
      mediaEl.textContent = 'Preview unavailable for this file. Use Save to download it.';
    }

    if (mediaEl.tagName !== 'DIV') {
      mediaEl.src = blobUrl;
      mediaEl.addEventListener('error', () => {
        container.textContent = 'This media could not be previewed. Use Save to download it.';
      }, { once: true });
    }

    container.appendChild(mediaEl);
    openModal('media-preview-modal');
  }

  function closeMediaPreview() {
    const modal = $('#media-preview-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    $('#media-preview-container').innerHTML = '';
    $('#media-preview-meta').textContent = '';
  }

  function renderMessage(msgId, text, type, ttl, senderPeerId, replyTo = null) {
    clearInitialBanner();
    const container = $('#messages-container');
    const el = document.createElement('div');
    el.className = `message ${type}`;
    el.id = `msg-${msgId}`;
    el.dataset.messageId = msgId;

    // Show sender label in group mode for incoming messages
    if (senderPeerId && type.includes('incoming')) {
      const sender = document.createElement('div');
      sender.className = 'message-sender';
      sender.textContent = senderPeerId.slice(0, 8) + '...';
      sender.dataset.color = peerColor(senderPeerId);
      el.appendChild(sender);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;

    if (replyTo?.preview) {
      el.appendChild(createReplyReference(replyTo));
    }

    const meta = createMessageMeta(ttl);
    el.appendChild(content);
    appendMessageActions(el, msgId, text);
    el.appendChild(meta.el);

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    messageRegistry.set(msgId, { element: el, text, type });

    startSelfDestruct(msgId, el, meta.timerEl, meta.progressBarEl, ttl);
  }

  function renderFileMessage(msgId, metadata, blobUrl, type, ttl, senderPeerId) {
    metadata = normalizeFileMetadata(metadata);
    rememberMediaUrl(msgId, blobUrl);
    clearInitialBanner();
    const container = $('#messages-container');
    const el = document.createElement('div');
    el.className = `message ${type}`;
    el.id = `msg-${msgId}`;
    el.dataset.messageId = msgId;

    // Show sender label in group mode for incoming files
    if (senderPeerId && type.includes('incoming')) {
      const sender = document.createElement('div');
      sender.className = 'message-sender';
      sender.textContent = senderPeerId.slice(0, 8) + '...';
      sender.dataset.color = peerColor(senderPeerId);
      el.appendChild(sender);
    }

    const bubble = document.createElement('div');
    bubble.className = 'file-bubble';

    // Special handling for View Once Media
    if (metadata.viewOnce) {
      const tile = document.createElement('div');
      tile.className = 'view-once-tile';
      tile.innerHTML = `
        <span class="view-once-tile-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>
        <span class="view-once-tile-text">Open once · ${metadata.name}</span>
      `;

      tile.addEventListener('click', () => {
        const container = $('#view-once-media-container');
        container.innerHTML = '';
        let mediaEl;
        if (metadata.mimeType.startsWith('image/')) {
          mediaEl = document.createElement('img');
          mediaEl.src = blobUrl;
          mediaEl.alt = metadata.name;
        } else if (metadata.mimeType.startsWith('video/')) {
          mediaEl = document.createElement('video');
          mediaEl.src = blobUrl;
          mediaEl.controls = true;
          mediaEl.autoplay = true;
          mediaEl.playsInline = true;
        } else if (metadata.mimeType.startsWith('audio/')) {
          mediaEl = document.createElement('audio');
          mediaEl.src = blobUrl;
          mediaEl.controls = true;
          mediaEl.autoplay = true;
        } else {
          mediaEl = document.createElement('div');
          mediaEl.textContent = `File: ${metadata.name} (${formatFileSize(metadata.size)})`;
        }
        container.appendChild(mediaEl);
        openModal('view-once-modal');

        // Mark tile as destroyed
        tile.innerHTML = '<span class="view-once-tile-text">Media opened and destroyed</span>';
        tile.style.opacity = '0.5';
        tile.style.pointerEvents = 'none';

        const closeHandler = () => {
          if (activeViewOnceCleanup !== closeHandler) return;
          activeViewOnceCleanup = null;
          activeViewOnceMsgId = null;
          forgetMediaUrl(msgId);
          container.innerHTML = '';
        };
        activeViewOnceCleanup = closeHandler;
        activeViewOnceMsgId = msgId;
        $('#view-once-modal .view-once-close-btn').addEventListener('click', closeHandler, { once: true });
        $('#view-once-modal .modal-backdrop').addEventListener('click', closeHandler, { once: true });
      });
      bubble.appendChild(tile);
    } 
    // Standard File Preview & Info
    else {
      const isImage = metadata.mimeType && metadata.mimeType.startsWith('image/');
      if (isImage) {
        const preview = document.createElement('div');
        preview.className = 'file-preview';
        preview.tabIndex = 0;
        preview.setAttribute('role', 'button');
        preview.setAttribute('aria-label', `Open image ${metadata.name}`);
        const img = document.createElement('img');
        img.src = blobUrl;
        img.alt = metadata.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        const openPreview = () => openMediaPreview(metadata, blobUrl);
        preview.addEventListener('click', openPreview);
        preview.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPreview();
          }
        });
        img.addEventListener('error', () => {
          preview.classList.add('is-broken');
          preview.textContent = 'Preview unavailable. Use Save to download the encrypted media.';
        }, { once: true });
        preview.appendChild(img);
        bubble.appendChild(preview);
      }

      const info = document.createElement('div');
      info.className = 'file-info';

      const icon = document.createElement('span');
      icon.className = 'file-info-icon';
      icon.textContent = getFileIcon(metadata.mimeType);

      const details = document.createElement('div');
      details.className = 'file-info-details';

      const name = document.createElement('div');
      name.className = 'file-info-name';
      name.title = metadata.name;
      name.textContent = metadata.name;

      const size = document.createElement('div');
      size.className = 'file-info-size';
      size.textContent = metadata.optimized
        ? `${formatFileSize(metadata.size)} · optimized locally`
        : formatFileSize(metadata.size);

      details.appendChild(name);
      details.appendChild(size);

      const dlBtn = document.createElement('button');
      dlBtn.className = 'file-download-btn';
      dlBtn.type = 'button';
      dlBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7m0 0L3 5.5M6 8l3-2.5M1 10h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Save';
      dlBtn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = metadata.name;
        a.click();
      });

      info.appendChild(icon);
      info.appendChild(details);
      info.appendChild(dlBtn);
      bubble.appendChild(info);
    }

    const meta = createMessageMeta(ttl);
    el.appendChild(bubble);
    appendMessageActions(el, msgId, metadata.name);
    el.appendChild(meta.el);

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    messageRegistry.set(msgId, { element: el, text: metadata.name, type });

    startSelfDestruct(msgId, el, meta.timerEl, meta.progressBarEl, ttl);
  }

  function createReplyReference(replyTo) {
    const reference = document.createElement('div');
    reference.className = 'message-reply-reference';
    const label = document.createElement('span');
    label.className = 'message-reply-label';
    label.textContent = 'Reply';
    const preview = document.createElement('span');
    preview.textContent = replyTo.preview;
    reference.append(label, preview);
    return reference;
  }

  function appendMessageActions(el, msgId, text) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'message-action';
    replyButton.dataset.messageAction = 'reply';
    replyButton.setAttribute('aria-label', 'Reply to this message');
    replyButton.textContent = 'Reply';
    actions.appendChild(replyButton);

    for (const label of ['Like', 'Agree', 'Thanks']) {
      const reactionButton = document.createElement('button');
      reactionButton.type = 'button';
      reactionButton.className = 'message-action';
      reactionButton.dataset.messageAction = 'reaction';
      reactionButton.dataset.reaction = label;
      reactionButton.setAttribute('aria-label', `${label} this message`);
      reactionButton.textContent = label;
      actions.appendChild(reactionButton);
    }

    el.appendChild(actions);
  }

  function beginReply(msgId) {
    const message = messageRegistry.get(msgId);
    if (!message) return;
    replyTarget = {
      id: msgId,
      preview: String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    };
    $('#reply-preview-text').textContent = replyTarget.preview || 'Encrypted media';
    $('#reply-preview').classList.remove('hidden');
    $('#message-input').focus();
  }

  function clearReplyTarget() {
    replyTarget = null;
    const preview = $('#reply-preview');
    if (preview) preview.classList.add('hidden');
    const previewText = $('#reply-preview-text');
    if (previewText) previewText.textContent = '';
  }

  async function sendReaction(targetId, label) {
    const key = isGroupChat ? groupKey : sharedKey;
    if (!key || !currentRoomId || !label) return;
    try {
      const payload = JSON.stringify({ kind: 'reaction', targetId, label });
      const { cipher, nonce } = await BitMaskCrypto.encrypt(key, payload);
      await BitMaskSocket.sendMessage(currentRoomId, cipher, nonce, messageTTL);
      applyReaction(targetId, label, messageTTL);
      BitMaskSound.playOutgoing();
    } catch (err) {
      showToast('Failed to send reaction: ' + err.message, 'error');
    }
  }

  function applyReaction(targetId, label, ttl) {
    const message = messageRegistry.get(targetId);
    if (!message?.element || !label) return;

    let reactions = message.element.querySelector('.message-reactions');
    if (!reactions) {
      reactions = document.createElement('div');
      reactions.className = 'message-reactions';
      message.element.insertBefore(reactions, message.element.querySelector('.message-meta'));
    }

    const chip = document.createElement('span');
    chip.className = 'message-reaction-chip';
    chip.textContent = label;
    reactions.appendChild(chip);
    setTimeout(() => chip.remove(), Math.max(5000, Number(ttl) || messageTTL));
  }

  function decodeMessagePayload(plaintext) {
    try {
      const parsed = JSON.parse(plaintext);
      if (parsed?.kind === 'reaction') return parsed;
      if (parsed?.kind === 'text' && typeof parsed.text === 'string') return parsed;
    } catch {
      // Messages from older clients are raw plaintext and remain readable.
    }
    return { kind: 'text', text: plaintext, replyTo: null };
  }

  function createMessageMeta(ttl) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const lockIcon = document.createElement('span');
    lockIcon.className = 'lock-icon';
    lockIcon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

    const time = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const timer = document.createElement('span');
    timer.className = 'self-destruct-timer';
    timer.dataset.ttl = ttl;

    meta.appendChild(lockIcon);
    meta.appendChild(time);
    meta.appendChild(timer);

    // Create the shrinking visual progress bar
    const progressContainer = document.createElement('div');
    progressContainer.className = 'destruct-progress-container';
    const progressBar = document.createElement('div');
    progressBar.className = 'destruct-progress-bar';
    progressContainer.appendChild(progressBar);
    meta.appendChild(progressContainer);

    return { el: meta, timerEl: timer, progressBarEl: progressBar };
  }

  // ══════════════════════════════════════════════════════════
  //  SELF-DESTRUCT TIMERS
  // ══════════════════════════════════════════════════════════

  function startSelfDestruct(msgId, el, timerEl, progressBarEl, ttl) {
    const endTime = Date.now() + ttl;

    // Trigger GPU-accelerated transition on progress bar (zero main-thread layout thrashing)
    if (progressBarEl) {
      progressBarEl.style.transformOrigin = 'left center';
      progressBarEl.style.transition = `transform ${ttl}ms linear`;
      requestAnimationFrame(() => {
        progressBarEl.style.transform = 'scaleX(0)';
      });
    }

    function check() {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        BitMaskSound.playDestroy();
        destroyMessage(el);
        if (messageTimers.has(msgId)) {
          clearInterval(messageTimers.get(msgId));
          messageTimers.delete(msgId);
        }
        return;
      }

      timerEl.textContent = formatCountdown(remaining);

      if (remaining < 5000) {
        el.classList.add('expiring');
      } else if (remaining < 15000) {
        el.classList.add('warning');
      }
    }

    check();
    const timerId = setInterval(check, 250);
    messageTimers.set(msgId, timerId);
  }

  function destroyMessage(el) {
    const msgId = el.dataset.messageId;
    if (msgId) forgetMediaUrl(msgId);
    if (msgId) messageRegistry.delete(msgId);
    el.classList.add('destroying');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 1000);
  }

  function destroyAllMessages() {
    messageTimers.forEach(timer => clearInterval(timer));
    messageTimers.clear();
    $$('.message').forEach(el => destroyMessage(el));
    messageRegistry.clear();
    clearIncomingFileTransfers();
    clearReplyTarget();
    revokeAllMediaUrls();
  }

  function addSystemMessage(text) {
    const container = $('#messages-container');
    const el = document.createElement('div');
    el.className = 'message system';
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  // ══════════════════════════════════════════════════════════
  //  MODAL HELPERS
  // ══════════════════════════════════════════════════════════

  function openModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal(id) {
    if (id === 'media-preview-modal') {
      closeMediaPreview();
      return;
    }
    if (id === 'view-once-modal' && activeViewOnceCleanup) {
      activeViewOnceCleanup();
    }
    const modal = $(`#${id}`);
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  // ══════════════════════════════════════════════════════════
  //  SYNC TOGGLES
  // ══════════════════════════════════════════════════════════

  function syncSoundToggle() {
    const on = BitMaskSound.isEnabled();
    $('#sound-icon-on').classList.toggle('hidden', !on);
    $('#sound-icon-off').classList.toggle('hidden', on);
  }

  function syncRememberMeToggle() {
    $('#remember-me-toggle').checked = BitMaskIdentity.isPersistent();
  }

  // ══════════════════════════════════════════════════════════
  //  STATUS & TOASTS
  // ══════════════════════════════════════════════════════════

  function updateStatus(status) {
    const dot = $('#status-dot');
    const label = $('#status-label');
    dot.className = `status-dot ${status}`;
    label.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  function updateChatSessionStatus(status) {
    const statusEl = $('#chat-session-status');
    const label = $('#chat-session-status-label');
    if (!statusEl || !label) return;
    const online = status === 'online';
    statusEl.classList.toggle('offline', !online);
    label.textContent = online ? 'Secure session' : 'Reconnecting…';
  }

  function startQualityMonitor() {
    stopQualityMonitor();
    measureConnectionQuality();
    qualityInterval = setInterval(measureConnectionQuality, 10000);
  }

  function stopQualityMonitor() {
    if (qualityInterval) clearInterval(qualityInterval);
    qualityInterval = null;
    updateNetworkQuality(null);
  }

  async function measureConnectionQuality() {
    try {
      const latency = await BitMaskSocket.measureLatency();
      updateNetworkQuality(latency);
    } catch {
      updateNetworkQuality(null);
    }
  }

  function updateNetworkQuality(latency) {
    const quality = $('#network-quality');
    const label = $('#network-quality-label');
    if (!quality || !label) return;

    quality.classList.remove('excellent', 'good', 'fair', 'poor', 'unknown');
    if (!Number.isFinite(latency)) {
      quality.classList.add('unknown');
      label.textContent = 'Unavailable';
      quality.title = 'Connection quality unavailable';
      return;
    }

    const state = latency < 100 ? 'excellent' : latency < 220 ? 'good' : latency < 450 ? 'fair' : 'poor';
    quality.classList.add(state);
    label.textContent = `${latency} ms`;
    quality.title = `Connection latency: ${latency} ms`;
  }

  async function prepareFileForSending(file, onProgress) {
    const type = file.type || guessMimeType(file.name);
    const shouldOptimize = type.startsWith('image/') && !['image/gif', 'image/svg+xml'].includes(type);
    if (!shouldOptimize || typeof window.createImageBitmap !== 'function') return file;

    onProgress?.('Optimizing image locally…');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const maxDimension = 1920;
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      context.drawImage(bitmap, 0, 0, width, height);
      const compressed = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      bitmap.close?.();
      if (!compressed || compressed.size >= file.size) return file;

      const baseName = (file.name || 'image').replace(/\.[^/.]+$/, '');
      return new File([compressed], `${baseName}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
    } catch (err) {
      bitmap?.close?.();
      console.info('[BitMask] Image optimization skipped:', err.message);
      return file;
    }
  }

  async function openQrScanner() {
    if (await openNativeQrScanner()) return;

    const status = $('#qr-scanner-status');
    const placeholder = $('#qr-scanner-placeholder');
    openModal('qr-scanner-modal');
    stopQrScanner();
    if (status) status.textContent = 'Preparing camera scanner…';
    if (placeholder) placeholder.classList.remove('hidden');

    if (typeof window.BarcodeDetector !== 'function') {
      if (status) status.textContent = 'Camera scanning is unavailable in this browser.';
      return;
    }

    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) throw new Error('QR scanning is not supported by this browser.');
      qrDetector = new BarcodeDetector({ formats: ['qr_code'] });
      await startQrCamera();
    } catch (err) {
      if (status) status.textContent = err.name === 'NotAllowedError'
        ? 'Camera permission was not granted. Close this view and try again.'
        : 'Camera scanner is unavailable in this browser.';
      console.info('[BitMask] QR camera unavailable:', err.message);
    }
  }

  async function openNativeQrScanner() {
    if (!window.BitMaskConfig?.isNative || !window.Capacitor?.registerPlugin) return false;

    try {
      const scanner = window.Capacitor.registerPlugin('CapacitorBarcodeScanner');
      const result = await scanner.scanBarcode({
        hint: 0,
        scanInstructions: 'Scan a BitMask peer or room QR code',
        scanButton: false,
        cameraDirection: 1,
        scanOrientation: 3,
        cancelButtonAccessibilityLabel: 'Cancel QR scan',
        android: { scanningLibrary: 'MLKIT' },
      });
      const rawValue = result?.ScanResult;
      if (rawValue) handleScannedValue(rawValue);
      return true;
    } catch (error) {
      const message = String(error?.message || error || '').toLowerCase();
      if (message.includes('cancel')) return true;
      console.info('[BitMask] Native QR scanner unavailable:', error);
      return false;
    }
  }

  async function startQrCamera() {
    if (!qrDetector) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable.');
    qrScannerStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const video = $('#qr-scanner-video');
    video.srcObject = qrScannerStream;
    await video.play();
    video.classList.add('active');
    $('#qr-scanner-placeholder')?.classList.add('hidden');
    $('#qr-scanner-status').textContent = 'Point your camera at a BitMask QR code.';
    scanQrFrame();
  }

  function scanQrFrame() {
    if (!qrScannerStream || !qrDetector || !$('#qr-scanner-video') || $('#qr-scanner-modal').classList.contains('hidden')) return;
    qrScannerFrame = requestAnimationFrame(async () => {
      if (!qrScanBusy) {
        qrScanBusy = true;
        try {
          const results = await qrDetector.detect($('#qr-scanner-video'));
          if (results?.[0]?.rawValue) {
            handleScannedValue(results[0].rawValue);
            return;
          }
        } catch (err) {
          console.info('[BitMask] QR frame skipped:', err.message);
        } finally {
          qrScanBusy = false;
        }
      }
      scanQrFrame();
    });
  }

  async function scanQrImage(file) {
    if (!file || !qrDetector) {
      $('#qr-scanner-status').textContent = 'Image scanning needs QR support in this browser.';
      return;
    }

    stopQrCameraOnly();
    $('#qr-scanner-status').textContent = 'Reading image…';
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const results = await qrDetector.detect(image);
      if (!results?.[0]?.rawValue) throw new Error('No QR code found.');
      handleScannedValue(results[0].rawValue);
    } catch {
      $('#qr-scanner-status').textContent = 'No BitMask QR code found in that image.';
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function handleScannedValue(rawValue) {
    const result = parseScannedValue(rawValue);
    if (!result) {
      $('#qr-scanner-status').textContent = 'That QR code is not a BitMask peer or room code.';
      return;
    }

    stopQrScanner();
    closeModal('qr-scanner-modal');
    if (result.kind === 'peer') {
      $('#target-peer-input').value = result.value;
      showToast('Peer ID scanned. Connecting…', 'success');
      submitForm($('#connect-form'));
    } else {
      $('#room-code-input').value = result.value;
      showToast('Room code scanned. Joining…', 'success');
      submitForm($('#join-group-form'));
    }
  }

  function submitForm(form) {
    if (!form) return;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }

  function parseScannedValue(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;

    let value = raw;
    try {
      const url = new URL(raw);
      if (url.hash) value = url.hash;
    } catch {
      // The QR may contain a raw peer ID or room code rather than a URL.
    }

    const hash = value.replace(/^#/, '');
    const peerMatch = hash.match(/^peer=([A-Fa-f0-9\s-]{16,24})$/i);
    if (peerMatch) value = peerMatch[1];
    const roomMatch = hash.match(/^room=([A-Za-z0-9]{6})$/i);
    if (roomMatch) return { kind: 'room', value: roomMatch[1].toUpperCase() };

    const compact = value.replace(/[\s-]/g, '').toUpperCase();
    if (/^[A-F0-9]{16}$/.test(compact)) return { kind: 'peer', value: compact };
    if (/^[A-HJ-NP-Z2-9]{6}$/.test(compact)) return { kind: 'room', value: compact };
    return null;
  }

  function stopQrCameraOnly() {
    if (qrScannerFrame) cancelAnimationFrame(qrScannerFrame);
    qrScannerFrame = null;
    if (qrScannerStream) {
      qrScannerStream.getTracks().forEach(track => track.stop());
      qrScannerStream = null;
    }
    const video = $('#qr-scanner-video');
    if (video) {
      video.pause();
      video.srcObject = null;
      video.classList.remove('active');
    }
  }

  function stopQrScanner() {
    stopQrCameraOnly();
    qrScanBusy = false;
  }

  function closeQrScannerModal() {
    stopQrScanner();
    closeModal('qr-scanner-modal');
  }

  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    toast.offsetHeight; // reflow
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
    }, 3500);
  }

  // ══════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════

  function formatPeerId(id) {
    if (!id) return '----';
    return String(id).match(/.{1,4}/g).join(' - ');
  }

  function formatTTL(ms) {
    if (ms < 60000) return `${ms / 1000}s`;
    if (ms < 3600000) return `${ms / 60000}m`;
    return `${ms / 3600000}h`;
  }

  function formatCountdown(ms) {
    if (ms < 60000) return `${Math.ceil(ms / 1000)}s`;
    if (ms < 3600000) {
      const m = Math.floor(ms / 60000);
      const s = Math.ceil((ms % 60000) / 1000);
      return `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.ceil((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  function formatFileSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getFileIcon(mimeType) {
    if (!mimeType) return 'FILE';
    if (mimeType.startsWith('image/')) return 'IMG';
    if (mimeType.startsWith('video/')) return 'VID';
    if (mimeType.startsWith('audio/')) return 'AUD';
    if (mimeType.includes('pdf')) return 'PDF';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return 'ZIP';
    if (mimeType.includes('text')) return 'TXT';
    return 'FILE';
  }

  function normalizeFileMetadata(metadata = {}) {
    const name = typeof metadata.name === 'string' && metadata.name.trim()
      ? metadata.name.trim().slice(-120)
      : 'Encrypted file';
    const rawMime = typeof metadata.mimeType === 'string' ? metadata.mimeType.trim() : '';
    const mimeType = /^[\w.+-]+\/[\w.+-]+(?:;[^\s]+)?$/.test(rawMime)
      ? rawMime.slice(0, 120)
      : 'application/octet-stream';
    return {
      name,
      mimeType,
      size: Math.max(0, Number(metadata.size) || 0),
      originalSize: Math.max(0, Number(metadata.originalSize) || Number(metadata.size) || 0),
      optimized: metadata.optimized === true,
      viewOnce: metadata.viewOnce === true,
    };
  }

  function guessMimeType(name = '') {
    const extension = String(name).toLowerCase().split('.').pop();
    const types = {
      avif: 'image/avif',
      bmp: 'image/bmp',
      gif: 'image/gif',
      heic: 'image/heic',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      pdf: 'application/pdf',
      json: 'application/json',
      txt: 'text/plain',
      zip: 'application/zip',
    };
    return types[extension] || 'application/octet-stream';
  }

  function cancelTyping() {
    if (isTypingSent && currentRoomId) {
      BitMaskSocket.sendTyping(currentRoomId, false);
      isTypingSent = false;
    }
  }

  function autoResizeInput() {
    const input = $('#message-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  // ══════════════════════════════════════════════════════════
  //  GROUP HELPERS
  // ══════════════════════════════════════════════════════════

  function peerColor(pid) {
    // Deterministic color index 0-9 based on peer ID
    let hash = 0;
    for (let i = 0; i < pid.length; i++) {
      hash = ((hash << 5) - hash + pid.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 10;
  }

  function updateMemberCount(count) {
    $('#member-count').textContent = count;
  }

  function updateTypingIndicator() {
    const indicator = $('#typing-indicator');
    if (typingPeers.size === 0) {
      indicator.classList.remove('visible');
      return;
    }
    indicator.classList.add('visible');
    const span = indicator.querySelector('span:last-child');
    if (typingPeers.size === 1) {
      const pid = [...typingPeers][0];
      span.textContent = `${pid.slice(0, 8)}... is typing...`;
    } else if (typingPeers.size === 2) {
      const ids = [...typingPeers];
      span.textContent = `${ids[0].slice(0, 6)} & ${ids[1].slice(0, 6)} are typing...`;
    } else {
      span.textContent = `${typingPeers.size} peers are typing...`;
    }
  }

  function renderMembersList() {
    const list = $('#members-list');
    list.innerHTML = '';

    for (const [pid] of groupMembers) {
      const item = document.createElement('div');
      item.className = 'member-item';

      const avatar = document.createElement('div');
      avatar.className = 'member-avatar';
      const colorIdx = peerColor(pid);
      const colors = ['#6C63FF','#E040FB','#4ADE80','#FBBF24','#F87171','#60A5FA','#34D399','#FB923C','#A78BFA','#F472B6'];
      avatar.style.background = colors[colorIdx];
      avatar.textContent = pid.slice(0, 2);

      const details = document.createElement('div');
      details.className = 'member-details';

      const peerIdEl = document.createElement('div');
      peerIdEl.className = 'member-peer-id';
      peerIdEl.textContent = formatPeerId(pid);

      const role = document.createElement('div');
      role.className = 'member-role';
      const roles = [];
      if (pid === peerId) roles.push('<span class="member-badge-you">you</span>');
      if (isHost && pid === peerId) roles.push('<span class="member-badge-host">host</span>');
      else if (!isHost && groupMembers.size > 0) {
        // We don't always know who the host is on the client after join,
        // but we know our own status
      }
      role.innerHTML = roles.join(' · ') || 'member';

      details.appendChild(peerIdEl);
      details.appendChild(role);

      item.appendChild(avatar);
      item.appendChild(details);
      list.appendChild(item);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ONE-CLICK HASH INVITE LINKS (#room=CODE)
  // ══════════════════════════════════════════════════════════

  function checkUrlHash() {
    const hash = window.location.hash;
    if (hash.startsWith('#room=')) {
      const code = hash.replace('#room=', '').trim();
      if (code && code.length === 6) {
        $('#room-code-input').value = code.toUpperCase();
        showToast(`Auto-joining room ${code.toUpperCase()} from invite link...`, 'info');
        setTimeout(() => {
          submitForm($('#join-group-form'));
        }, 600);
      }
    } else if (hash.startsWith('#peer=')) {
      const pid = hash.replace('#peer=', '').trim();
      if (pid && pid.length === 16) {
        $('#target-peer-input').value = pid.toUpperCase();
        showToast(`Connecting to peer ${pid.toUpperCase()}...`, 'info');
        setTimeout(() => {
          submitForm($('#connect-form'));
        }, 600);
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────
  return { init };
})();

// Boot up when DOM is ready
document.addEventListener('DOMContentLoaded', BitMaskApp.init);
