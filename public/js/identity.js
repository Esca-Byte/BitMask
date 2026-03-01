// ─────────────────────────────────────────────────────────────
//  BitMask — Identity Persistence Module
// ─────────────────────────────────────────────────────────────
//  Handles: Remember Me toggle, Export/Import, Passphrase lock
// ─────────────────────────────────────────────────────────────

const BitMaskIdentity = (() => {
  const STORAGE_KEY_PEER = 'bitmask_peerId';
  const STORAGE_KEY_KEYS = 'bitmask_keyPair';
  const STORAGE_KEY_PUB = 'bitmask_publicKeyBase64';
  const STORAGE_KEY_MODE = 'bitmask_storageMode'; // 'session' | 'persistent'
  const STORAGE_KEY_LOCKED = 'bitmask_lockedIdentity'; // passphrase-encrypted blob
  const PBKDF2_ITERATIONS = 310000;

  // ── Storage Mode ───────────────────────────────────────────

  function getStorageMode() {
    return localStorage.getItem(STORAGE_KEY_MODE) || 'session';
  }

  function setStorageMode(mode) {
    localStorage.setItem(STORAGE_KEY_MODE, mode);
  }

  function getStore() {
    return getStorageMode() === 'persistent' ? localStorage : sessionStorage;
  }

  // ── Save / Load / Clear ────────────────────────────────────

  async function save(peerId, keyPair, publicKeyBase64) {
    const store = getStore();
    const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    store.setItem(STORAGE_KEY_PEER, peerId);
    store.setItem(STORAGE_KEY_KEYS, JSON.stringify({ priv: privJwk, pub: pubJwk }));
    store.setItem(STORAGE_KEY_PUB, publicKeyBase64);
  }

  async function load() {
    // Check persistent first, then session
    let store = localStorage;
    let peerId = store.getItem(STORAGE_KEY_PEER);
    let storedKeys = store.getItem(STORAGE_KEY_KEYS);
    let pubBase64 = store.getItem(STORAGE_KEY_PUB);

    if (!peerId || !storedKeys) {
      store = sessionStorage;
      peerId = store.getItem(STORAGE_KEY_PEER);
      storedKeys = store.getItem(STORAGE_KEY_KEYS);
      pubBase64 = store.getItem(STORAGE_KEY_PUB);
    }

    if (!peerId || !storedKeys) return null;

    try {
      const keys = JSON.parse(storedKeys);
      const keyPair = {
        privateKey: await crypto.subtle.importKey(
          'jwk', keys.priv,
          { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
        ),
        publicKey: await crypto.subtle.importKey(
          'jwk', keys.pub,
          { name: 'ECDH', namedCurve: 'P-256' }, true, []
        ),
      };
      return { peerId, keyPair, publicKeyBase64: pubBase64 };
    } catch (e) {
      console.error('[Identity] Failed to restore keys:', e);
      return null;
    }
  }

  function clear() {
    [sessionStorage, localStorage].forEach(store => {
      store.removeItem(STORAGE_KEY_PEER);
      store.removeItem(STORAGE_KEY_KEYS);
      store.removeItem(STORAGE_KEY_PUB);
    });
  }

  // ── Remember Me (move between storages) ────────────────────

  async function enablePersistence() {
    // Copy from session to local
    const data = await load();
    if (!data) return false;
    setStorageMode('persistent');
    await save(data.peerId, data.keyPair, data.publicKeyBase64);
    // Clean session copy
    sessionStorage.removeItem(STORAGE_KEY_PEER);
    sessionStorage.removeItem(STORAGE_KEY_KEYS);
    sessionStorage.removeItem(STORAGE_KEY_PUB);
    return true;
  }

  async function disablePersistence() {
    const data = await load();
    if (!data) return false;
    setStorageMode('session');
    await save(data.peerId, data.keyPair, data.publicKeyBase64);
    // Clean local copy
    localStorage.removeItem(STORAGE_KEY_PEER);
    localStorage.removeItem(STORAGE_KEY_KEYS);
    localStorage.removeItem(STORAGE_KEY_PUB);
    return true;
  }

  function isPersistent() {
    return getStorageMode() === 'persistent';
  }

  // ── PBKDF2 Key Derivation from Passphrase ─────────────────

  async function _deriveKeyFromPassphrase(passphrase, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Export Identity ────────────────────────────────────────

  /**
   * Export identity as an encrypted JSON blob (downloadable).
   * If no passphrase is given, the blob is unencrypted (not recommended).
   */
  async function exportIdentity(peerId, keyPair, publicKeyBase64, passphrase) {
    const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const payload = JSON.stringify({
      version: 1,
      peerId,
      publicKeyBase64,
      keys: { priv: privJwk, pub: pubJwk },
      exportedAt: new Date().toISOString(),
    });

    if (!passphrase) {
      // Unencrypted export
      return JSON.stringify({ encrypted: false, data: payload });
    }

    // Encrypted export
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await _deriveKeyFromPassphrase(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(payload)
    );

    return JSON.stringify({
      encrypted: true,
      salt: _bufToHex(salt),
      iv: _bufToHex(iv),
      data: _bufToHex(new Uint8Array(ciphertext)),
    });
  }

  /**
   * Import identity from an exported blob. Returns { peerId, keyPair, publicKeyBase64 }.
   */
  async function importIdentity(blob, passphrase) {
    const parsed = JSON.parse(blob);

    let payloadStr;
    if (!parsed.encrypted) {
      payloadStr = parsed.data;
    } else {
      if (!passphrase) throw new Error('Passphrase required to decrypt this identity.');
      const salt = _hexToBuf(parsed.salt);
      const iv = _hexToBuf(parsed.iv);
      const ciphertext = _hexToBuf(parsed.data);
      const key = await _deriveKeyFromPassphrase(passphrase, salt);
      try {
        const plainBuf = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv }, key, ciphertext
        );
        payloadStr = new TextDecoder().decode(plainBuf);
      } catch {
        throw new Error('Wrong passphrase or corrupted file.');
      }
    }

    const payload = JSON.parse(payloadStr);
    if (payload.version !== 1) throw new Error('Unsupported identity file version.');

    const keyPair = {
      privateKey: await crypto.subtle.importKey(
        'jwk', payload.keys.priv,
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
      ),
      publicKey: await crypto.subtle.importKey(
        'jwk', payload.keys.pub,
        { name: 'ECDH', namedCurve: 'P-256' }, true, []
      ),
    };

    return {
      peerId: payload.peerId,
      keyPair,
      publicKeyBase64: payload.publicKeyBase64,
    };
  }

  // ── Passphrase Lock (encrypt identity in localStorage) ─────

  /**
   * Lock current identity with a passphrase. Stores encrypted blob in localStorage.
   * The unencrypted keys are removed.
   */
  async function lockWithPassphrase(peerId, keyPair, publicKeyBase64, passphrase) {
    const blob = await exportIdentity(peerId, keyPair, publicKeyBase64, passphrase);
    localStorage.setItem(STORAGE_KEY_LOCKED, blob);
    // Remove plaintext keys
    localStorage.removeItem(STORAGE_KEY_KEYS);
    sessionStorage.removeItem(STORAGE_KEY_KEYS);
    // Keep peerId so we can display it on the lock screen
    localStorage.setItem(STORAGE_KEY_PEER, peerId);
    setStorageMode('persistent');
    return true;
  }

  /**
   * Unlock identity with passphrase from the stored encrypted blob.
   */
  async function unlockWithPassphrase(passphrase) {
    const blob = localStorage.getItem(STORAGE_KEY_LOCKED);
    if (!blob) throw new Error('No locked identity found.');
    const result = await importIdentity(blob, passphrase);
    // Restore to storage
    await save(result.peerId, result.keyPair, result.publicKeyBase64);
    return result;
  }

  /**
   * Check if there's a passphrase-locked identity waiting to be unlocked.
   */
  function isLocked() {
    return !!localStorage.getItem(STORAGE_KEY_LOCKED) && !localStorage.getItem(STORAGE_KEY_KEYS);
  }

  function getLockedPeerId() {
    return localStorage.getItem(STORAGE_KEY_PEER);
  }

  function removeLock() {
    localStorage.removeItem(STORAGE_KEY_LOCKED);
  }

  // ── Download Helper ────────────────────────────────────────

  function downloadBlob(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Hex Utilities ──────────────────────────────────────────

  function _bufToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // ── Public API ─────────────────────────────────────────────
  return {
    save,
    load,
    clear,
    enablePersistence,
    disablePersistence,
    isPersistent,
    exportIdentity,
    importIdentity,
    lockWithPassphrase,
    unlockWithPassphrase,
    isLocked,
    getLockedPeerId,
    removeLock,
    downloadBlob,
    getStorageMode,
  };
})();
