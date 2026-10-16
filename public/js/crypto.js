// ─────────────────────────────────────────────────────────────
//  BitMask — End-to-End Encryption Module (Web Crypto API)
// ─────────────────────────────────────────────────────────────
//  Uses ECDH for key exchange + AES-GCM for message encryption.
//  The server NEVER sees plaintext — only ciphertext blobs.
// ─────────────────────────────────────────────────────────────

const BitMaskCrypto = (() => {
  const ALGO_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const ALGO_AES = { name: 'AES-GCM', length: 256 };

  // ── Key Generation ─────────────────────────────────────────

  /**
   * Generate an ECDH key pair for this session.
   * Returns { publicKey, privateKey } as CryptoKey objects.
   */
  async function generateKeyPair() {
    return await crypto.subtle.generateKey(ALGO_ECDH, true, ['deriveKey']);
  }

  /**
   * Export a CryptoKey (public) to a base64 string for transmission.
   */
  async function exportPublicKey(publicKey) {
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  }

  /**
   * Import a base64-encoded public key back into a CryptoKey.
   */
  async function importPublicKey(base64Key) {
    const binary = atob(base64Key);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await crypto.subtle.importKey(
      'raw',
      bytes,
      ALGO_ECDH,
      true,
      []
    );
  }

  // ── Key Derivation ─────────────────────────────────────────

  /**
   * Derive a shared AES-GCM key from our private key + their public key.
   */
  async function deriveSharedKey(privateKey, peerPublicKey) {
    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      privateKey,
      ALGO_AES,
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Encryption / Decryption ────────────────────────────────

  /**
   * Encrypt a plaintext string with the shared AES-GCM key.
   * Returns { cipher: base64, nonce: base64 }
   */
  async function encrypt(sharedKey, plaintext) {
    const encoder = new TextEncoder();
    const nonce = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      sharedKey,
      encoder.encode(plaintext)
    );
    return {
      cipher: bufferToBase64(cipherBuffer),
      nonce: bufferToBase64(nonce),
    };
  }

  /**
   * Decrypt a ciphertext with the shared AES-GCM key.
   * Returns the plaintext string.
   */
  async function decrypt(sharedKey, cipherBase64, nonceBase64) {
    const cipherBuffer = base64ToBuffer(cipherBase64);
    const nonce = base64ToBuffer(nonceBase64);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      sharedKey,
      cipherBuffer
    );
    return new TextDecoder().decode(plainBuffer);
  }

  // ── Peer ID Generation ─────────────────────────────────────

  /**
   * Generate a cryptographically secure 16-character hex Peer ID.
   */
  function generatePeerId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  // ── Group Key Management ──────────────────────────────────

  /**
   * Generate a random AES-256-GCM key for group encryption.
   * Returns a CryptoKey usable for encrypt/decrypt.
   */
  async function generateGroupKey() {
    return await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
  }

  /**
   * Export a CryptoKey (AES) to a base64 string for transmission.
   */
  async function exportRawKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return bufferToBase64(raw);
  }

  /**
   * Import a base64-encoded raw AES key back into a CryptoKey.
   */
  async function importRawKey(base64Key) {
    const rawBuffer = base64ToBuffer(base64Key);
    return await crypto.subtle.importKey(
      'raw',
      rawBuffer,
      ALGO_AES,
      true,
      ['encrypt', 'decrypt']
    );
  }

  // ── File Encryption / Decryption ─────────────────────────────

  /**
   * Encrypt a file (ArrayBuffer) with the shared AES-GCM key.
   * Returns { cipher: base64, nonce: base64 }
   */
  async function encryptFile(sharedKey, fileBuffer) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      sharedKey,
      fileBuffer
    );
    return {
      cipher: bufferToBase64(cipherBuffer),
      nonce: bufferToBase64(nonce),
    };
  }

  /**
   * Decrypt a file ciphertext back into an ArrayBuffer.
   */
  async function decryptFile(sharedKey, cipherBase64, nonceBase64) {
    const cipherBuffer = base64ToBuffer(cipherBase64);
    const nonce = base64ToBuffer(nonceBase64);
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      sharedKey,
      cipherBuffer
    );
  }

  /**
   * Encrypt a file as independently authenticated chunks. Each chunk gets a
   * fresh nonce, so large media never has to cross the Socket.io frame limit.
   */
  async function encryptFileChunks(sharedKey, fileBuffer, chunkSize = 512 * 1024, onProgress) {
    const source = new Uint8Array(fileBuffer);
    const chunks = [];
    const total = Math.max(1, Math.ceil(source.byteLength / chunkSize));

    for (let offset = 0, index = 0; offset < source.byteLength || (source.byteLength === 0 && index === 0); offset += chunkSize, index++) {
      const chunk = source.slice(offset, Math.min(offset + chunkSize, source.byteLength));
      const encrypted = await encryptFile(sharedKey, chunk.buffer);
      chunks.push(encrypted);
      onProgress?.(index + 1, total);
      if (source.byteLength === 0) break;
    }

    return chunks;
  }

  /** Decrypt and join independently authenticated file chunks in order. */
  async function decryptFileChunks(sharedKey, chunks, onProgress) {
    const buffers = [];
    for (let index = 0; index < chunks.length; index++) {
      const buffer = await decryptFile(sharedKey, chunks[index].cipher, chunks[index].nonce);
      buffers.push(new Uint8Array(buffer));
      onProgress?.(index + 1, chunks.length);
    }

    const totalLength = buffers.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
      joined.set(buffer, offset);
      offset += buffer.byteLength;
    }
    return joined.buffer;
  }

  // ── Utility ────────────────────────────────────────────────

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    // Handle large buffers in chunks to avoid stack overflow
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // ── Public API ─────────────────────────────────────────────
  return {
    generateKeyPair,
    exportPublicKey,
    importPublicKey,
    deriveSharedKey,
    encrypt,
    decrypt,
    encryptFile,
    decryptFile,
    encryptFileChunks,
    decryptFileChunks,
    generateGroupKey,
    exportRawKey,
    importRawKey,
    generatePeerId,
  };
})();
