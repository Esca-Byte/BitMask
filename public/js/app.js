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

  // ── Group State ────────────────────────────────────────────
  let isGroupChat = false;
  let groupKey = null;          // AES-256 CryptoKey for group encryption
  let roomCode = null;          // 6-char room code
  let isHost = false;
  let groupMembers = new Map(); // peerId -> { publicKey }
  let typingPeers = new Set();  // peer IDs currently typing

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
      showToast('Started with a fresh identity.', 'info');
    });
  }

  // ══════════════════════════════════════════════════════════
  //  SOCKET EVENT HANDLERS
  // ══════════════════════════════════════════════════════════

  function setupSocketHandlers() {
    BitMaskSocket.on('onConnect', async () => {
      updateStatus('online');
      try {
        await BitMaskSocket.register(peerId, publicKeyBase64);
        showToast('Identity secured. You are online.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    BitMaskSocket.on('onDisconnect', () => {
      updateStatus('offline');
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
        renderMessage(msg.id, plaintext, 'incoming', msg.ttl, isGroupChat ? msg.from : null);
        BitMaskSound.playIncoming();
      } catch (err) {
        console.error('Decryption failed:', err);
        renderMessage(msg.id, '[Decryption failed]', 'incoming error', msg.ttl, isGroupChat ? msg.from : null);
      }
    });

    // ── Incoming File ──
    BitMaskSocket.on('onFile', async (data) => {
      const key = isGroupChat ? groupKey : sharedKey;
      if (!key) return;
      try {
        const decrypted = await BitMaskCrypto.decryptFile(key, data.cipher, data.nonce);
        const blob = new Blob([decrypted], { type: data.metadata.mimeType });
        const url = URL.createObjectURL(blob);
        renderFileMessage(data.id, data.metadata, url, 'incoming', data.ttl, isGroupChat ? data.from : null);
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
      const svg = BitMaskQR.toSVG(peerId, { moduleSize: 6, margin: 2 });
      $('#qr-container').innerHTML = svg;
      $('#qr-peer-id').textContent = formatPeerId(peerId);
      openModal('qr-modal');
    });

    // ── QR Copy Button ──
    $('#qr-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(peerId).then(() => {
        const btn = $('#qr-copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy ID', 1500);
      });
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
      input.focus();
      cancelTyping();

      try {
        const { cipher, nonce } = await BitMaskCrypto.encrypt(key, text);
        const res = await BitMaskSocket.sendMessage(currentRoomId, cipher, nonce, messageTTL);
        renderMessage(res.msgId, text, 'outgoing', messageTTL);
        BitMaskSound.playOutgoing();
      } catch (err) {
        showToast('Failed to send: ' + err.message, 'error');
      }
    });

    // ── Typing indicator ──
    $('#message-input').addEventListener('input', () => {
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

    // ── Copy Room Code (chat header) ──
    $('#copy-room-code-btn').addEventListener('click', () => {
      if (roomCode) {
        navigator.clipboard.writeText(roomCode).then(() => {
          showToast('Room code copied!', 'success');
        });
      }
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
  }

  // ══════════════════════════════════════════════════════════
  //  MODAL HANDLERS (Export / Import / Lock)
  // ══════════════════════════════════════════════════════════

  function setupModalHandlers() {
    // ── Close modals via backdrop / X button ──
    $$('.modal-backdrop').forEach(bd => {
      bd.addEventListener('click', () => {
        bd.closest('.modal').classList.add('hidden');
      });
    });
    $$('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').classList.add('hidden');
      });
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

    attachBtn.addEventListener('click', () => {
      const key = isGroupChat ? groupKey : sharedKey;
      if (!key || !currentRoomId) {
        showToast('Connect to a peer first.', 'warning');
        return;
      }
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = ''; // Reset

      const MAX_SIZE = 5 * 1024 * 1024; // 5MB
      if (file.size > MAX_SIZE) {
        showToast('File too large. Maximum 5MB.', 'error');
        return;
      }

      const key = isGroupChat ? groupKey : sharedKey;
      if (!key) {
        showToast('Encryption key not ready.', 'warning');
        return;
      }

      try {
        const sendingMsg = addSystemMessage(`Sending ${file.name}...`);
        const buffer = await file.arrayBuffer();
        const { cipher, nonce } = await BitMaskCrypto.encryptFile(key, buffer);

        const metadata = {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        };

        const res = await BitMaskSocket.sendFile(currentRoomId, cipher, nonce, metadata, messageTTL);

        // Remove the "Sending..." indicator
        if (sendingMsg && sendingMsg.parentNode) sendingMsg.remove();

        // Render locally
        const blob = new Blob([buffer], { type: file.type });
        const url = URL.createObjectURL(blob);
        renderFileMessage(res.msgId, metadata, url, 'outgoing', messageTTL);
        BitMaskSound.playOutgoing();
      } catch (err) {
        showToast('Failed to send file: ' + err.message, 'error');
      }
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
    // 1:1 mode
    $('#chat-direct-info').classList.remove('hidden');
    $('#chat-group-info').classList.add('hidden');
    $('#member-count-btn').classList.add('hidden');
    $('#connected-peer-id').textContent = formatPeerId(remotePeerId);
    $('#messages-container').innerHTML = '';
    addSystemMessage('End-to-end encrypted session established.');
    addSystemMessage(`Messages will self-destruct after ${formatTTL(messageTTL)}.`);
    $('#message-input').focus();
  }

  function switchToGroupChat() {
    showView('chat-view');
    // Group mode
    $('#chat-direct-info').classList.add('hidden');
    $('#chat-group-info').classList.remove('hidden');
    $('#member-count-btn').classList.remove('hidden');
    $('#group-room-code').textContent = roomCode;
    updateMemberCount(groupMembers.size);
    $('#messages-container').innerHTML = '';
    addSystemMessage('Group room joined. End-to-end encrypted.');
    addSystemMessage(`Room code: ${roomCode} — Share it so others can join.`);
    addSystemMessage(`Messages will self-destruct after ${formatTTL(messageTTL)}.`);
    if (isHost) {
      addSystemMessage('You are the room host. Group key will be distributed automatically.');
    } else {
      addSystemMessage('Waiting for group encryption key from host...');
    }
    $('#message-input').focus();
  }

  function resetChatState() {
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

  function renderMessage(msgId, text, type, ttl, senderPeerId) {
    const container = $('#messages-container');
    const el = document.createElement('div');
    el.className = `message ${type}`;
    el.id = `msg-${msgId}`;

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

    const meta = createMessageMeta(ttl);
    el.appendChild(content);
    el.appendChild(meta.el);

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;

    startSelfDestruct(msgId, el, meta.timerEl, ttl);
  }

  function renderFileMessage(msgId, metadata, blobUrl, type, ttl, senderPeerId) {
    const container = $('#messages-container');
    const el = document.createElement('div');
    el.className = `message ${type}`;
    el.id = `msg-${msgId}`;

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

    // Preview for images
    const isImage = metadata.mimeType && metadata.mimeType.startsWith('image/');
    if (isImage) {
      const preview = document.createElement('div');
      preview.className = 'file-preview';
      const img = document.createElement('img');
      img.src = blobUrl;
      img.alt = metadata.name;
      img.loading = 'lazy';
      // Click to open full-size in new tab
      preview.addEventListener('click', () => window.open(blobUrl, '_blank'));
      preview.appendChild(img);
      bubble.appendChild(preview);
    }

    // File info row
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
    size.textContent = formatFileSize(metadata.size);

    details.appendChild(name);
    details.appendChild(size);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'file-download-btn';
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

    const meta = createMessageMeta(ttl);
    el.appendChild(bubble);
    el.appendChild(meta.el);

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;

    startSelfDestruct(msgId, el, meta.timerEl, ttl);
  }

  function createMessageMeta(ttl) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const lockIcon = document.createElement('span');
    lockIcon.className = 'lock-icon';
    lockIcon.textContent = '🔒';

    const time = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const timer = document.createElement('span');
    timer.className = 'self-destruct-timer';
    timer.dataset.ttl = ttl;

    meta.appendChild(lockIcon);
    meta.appendChild(time);
    meta.appendChild(timer);

    return { el: meta, timerEl: timer };
  }

  // ══════════════════════════════════════════════════════════
  //  SELF-DESTRUCT TIMERS
  // ══════════════════════════════════════════════════════════

  function startSelfDestruct(msgId, el, timerEl, ttl) {
    const endTime = Date.now() + ttl;

    function tick() {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        BitMaskSound.playDestroy();
        destroyMessage(el);
        messageTimers.delete(msgId);
        return;
      }
      timerEl.textContent = formatCountdown(remaining);

      if (remaining < 5000) {
        el.classList.add('expiring');
      } else if (remaining < 15000) {
        el.classList.add('warning');
      }

      messageTimers.set(msgId, requestAnimationFrame(tick));
    }
    tick();
  }

  function destroyMessage(el) {
    el.classList.add('destroying');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 1000);
  }

  function destroyAllMessages() {
    messageTimers.forEach(timer => cancelAnimationFrame(timer));
    messageTimers.clear();
    $$('.message').forEach(el => destroyMessage(el));
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
    $(`#${id}`).classList.remove('hidden');
  }

  function closeModal(id) {
    $(`#${id}`).classList.add('hidden');
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
    return id.match(/.{1,4}/g).join(' - ');
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
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getFileIcon(mimeType) {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '🗜️';
    if (mimeType.includes('text')) return '📝';
    return '📄';
  }

  function cancelTyping() {
    if (isTypingSent && currentRoomId) {
      BitMaskSocket.sendTyping(currentRoomId, false);
      isTypingSent = false;
    }
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

  // ── Public API ─────────────────────────────────────────────
  return { init };
})();

// Boot up when DOM is ready
document.addEventListener('DOMContentLoaded', BitMaskApp.init);
