// ─────────────────────────────────────────────────────────────
//  BitMask — Emergency Panic / Duress Module
// ─────────────────────────────────────────────────────────────
//  Instantly wipes all browser storage, crypto keys, active socket
//  connections, DOM elements, and redirects the tab to safety.
// ─────────────────────────────────────────────────────────────

const BitMaskPanic = (() => {
  let isPanicking = false;

  function trigger(redirectUrl = 'https://google.com') {
    if (isPanicking) return;
    isPanicking = true;

    try {
      // 1. Wipe all local & session storage
      if (window.BitMaskIdentity) {
        window.BitMaskIdentity.clear();
        window.BitMaskIdentity.removeLock();
      }
      localStorage.clear();
      sessionStorage.clear();

      // 2. Disconnect socket
      if (window.BitMaskSocket) {
        window.BitMaskSocket.disconnect();
      }

      // 3. Clear cookies
      document.cookie.split(";").forEach((c) => {
        document.cookie = c
          .replace(/^ +/, "")
          .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });

      // 4. Wipe DOM body immediately
      document.body.innerHTML = `
        <div style="background:#000;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;font-family:sans-serif;">
          <h2>Clearing session...</h2>
        </div>
      `;

      // 5. Hard redirect
      window.location.replace(redirectUrl);
    } catch (e) {
      window.location.href = redirectUrl;
    }
  }

  function init() {
    // Keystroke listener: Alt + Shift + X
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'X' || e.key === 'x' || e.code === 'KeyX')) {
        e.preventDefault();
        trigger();
      }
    });
  }

  // Initialize event listeners when DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { trigger };
})();
