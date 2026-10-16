// ─────────────────────────────────────────────────────────────
// BitMask — Runtime connection configuration
// ─────────────────────────────────────────────────────────────
// Web deployments use the current origin. The bundled Android app needs the
// public Render URL for the relay server. Set window.BITMASK_SERVER_URL before
// this script or replace the empty value below before building the APK.

(() => {
  // Set this once to your Render web-service URL before producing the APK.
  // Example: https://bitmask-api.onrender.com
  const RENDER_SERVER_URL = 'https://bitmask-lpf2.onrender.com';
  const nativePlatform = Boolean(
    window.Capacitor?.isNativePlatform?.() ||
    ['capacitor:', 'ionic:'].includes(window.location.protocol)
  );
  const configured = window.BITMASK_SERVER_URL || RENDER_SERVER_URL;
  const serverUrl = (configured || (nativePlatform ? '' : window.location.origin))
    .replace(/\/$/, '');

  window.BitMaskConfig = Object.freeze({
    isNative: nativePlatform,
    serverUrl,
  });
})();
