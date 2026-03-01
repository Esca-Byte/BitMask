// ─────────────────────────────────────────────────────────────
//  BitMask — Sound Notification Module
// ─────────────────────────────────────────────────────────────
//  Synthesizes notification sounds using Web Audio API.
//  No external audio files needed.
// ─────────────────────────────────────────────────────────────

const BitMaskSound = (() => {
  let audioCtx = null;
  let enabled = true;

  function _getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function _resumeCtx() {
    const ctx = _getCtx();
    if (ctx.state === 'suspended') ctx.resume();
  }

  /**
   * Play a short "blip" for incoming messages.
   */
  function playIncoming() {
    if (!enabled) return;
    _resumeCtx();
    const ctx = _getCtx();
    const now = ctx.currentTime;

    // Two-tone ascending blip
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(520, now);
    osc1.frequency.exponentialRampToValueAtTime(680, now + 0.08);

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(780, now + 0.1);
    osc2.frequency.exponentialRampToValueAtTime(880, now + 0.18);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.1);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.25);
  }

  /**
   * Play a soft "thud" for outgoing messages.
   */
  function playOutgoing() {
    if (!enabled) return;
    _resumeCtx();
    const ctx = _getCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(380, now + 0.06);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  /**
   * Play a connection chime.
   */
  function playConnect() {
    if (!enabled) return;
    _resumeCtx();
    const ctx = _getCtx();
    const now = ctx.currentTime;

    [440, 554, 659].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + i * 0.12;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.1, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  /**
   * Play a disconnect sound (descending).
   */
  function playDisconnect() {
    if (!enabled) return;
    _resumeCtx();
    const ctx = _getCtx();
    const now = ctx.currentTime;

    [659, 554, 440].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + i * 0.12;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  /**
   * Play a self-destruct "fizzle" sound.
   */
  function playDestroy() {
    if (!enabled) return;
    _resumeCtx();
    const ctx = _getCtx();
    const now = ctx.currentTime;

    // White noise burst
    const bufferSize = ctx.sampleRate * 0.15;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.03;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    noise.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  function setEnabled(on) {
    enabled = on;
    localStorage.setItem('bitmask_sound', on ? '1' : '0');
  }

  function isEnabled() {
    const stored = localStorage.getItem('bitmask_sound');
    if (stored !== null) enabled = stored === '1';
    return enabled;
  }

  // Initialize from stored preference
  isEnabled();

  return {
    playIncoming,
    playOutgoing,
    playConnect,
    playDisconnect,
    playDestroy,
    setEnabled,
    isEnabled,
  };
})();
