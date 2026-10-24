// ─────────────────────────────────────────────────────────────
//  BitMask — WebRTC E2EE calling controller
// ─────────────────────────────────────────────────────────────

class BitMaskCallController {
  constructor() {
    this.localStream = null;
    this.peerConnection = null;
    this.roomId = null;
    this.targetPeerId = null;
    this.callType = null; // 'voice' or 'video'
    this.isCallActive = false;
    this.callId = null;
    this.callState = 'idle'; // idle | requesting | outgoing-ringing | incoming | connecting | connected
    this.incomingTimeout = null;
    this.isMuted = false;
    this.isCameraOff = false;
    this.audioContext = null;
    this.ringInterval = null;

    // Standard public Google STUN server for NAT traversal
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  createCallId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = window.crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  isCallInProgress() {
    return this.callState !== 'idle' || Boolean(this.callId || this.incomingTimeout);
  }

  clearIncomingTimeout() {
    if (this.incomingTimeout) clearTimeout(this.incomingTimeout);
    this.incomingTimeout = null;
  }

  setCallState(state) {
    this.callState = state;
    const badge = document.querySelector('.call-badge');
    if (!badge) return;
    const labels = {
      requesting: 'REQUESTING CALL',
      'outgoing-ringing': 'CALLING',
      incoming: 'INCOMING CALL',
      connecting: 'CONNECTING',
      connected: 'CALL ACTIVE',
      idle: 'CALL ENDED',
    };
    badge.textContent = labels[state] || 'CALL';
  }

  // ── Procedural Sound Ringing Synthesizer ───────────────────
  // Generates premium electronic call ringing tones without any static file assets!
  startRingingTone() {
    try {
      this.stopRingingTone();
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const playTone = () => {
        if (!this.audioContext || this.audioContext.state === 'closed') return;
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(440, this.audioContext.currentTime); // Standard ring frequency A
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(480, this.audioContext.currentTime); // Standard ring frequency B

        gain.gain.setValueAtTime(0.08, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 1.2);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.audioContext.destination);

        osc1.start();
        osc2.start();
        osc1.stop(this.audioContext.currentTime + 1.2);
        osc2.stop(this.audioContext.currentTime + 1.2);
      };

      playTone();
      this.ringInterval = setInterval(playTone, 2000);
    } catch (e) {
      console.warn("Failed to play ringing tone:", e);
    }
  }

  stopRingingTone() {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  // ── Resilient Media Stream Loader with Downgrade ───────────
  async acquireMediaStream(constraints) {
    // 1. Context validation (Insecure origins block mediaDevices entirely in modern browsers)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("[Call] navigator.mediaDevices.getUserMedia is undefined.");
      throw new Error("INSECURE_CONTEXT");
    }

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // 2. Gracious video device missing/denied fallback loop
      if (constraints.video) {
        console.warn("[Call] Camera missing or denied. Gracefully falling back to audio-only...", err);
        showToast("Camera blocked or missing. Fallback to Voice call.", "warning");
        
        // Dynamically alter session parameters
        this.callType = 'voice';
        this.updateUIPostDowngrade();

        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (audioErr) {
          throw audioErr;
        }
      }
      throw err;
    }
  }

  // ── Initiate Outgoing Call ─────────────────────────────────
  async startCall(roomId, targetPeerId, type) {
    if (this.isCallInProgress()) return;

    this.roomId = roomId;
    this.targetPeerId = targetPeerId;
    this.callType = type;
    this.callId = this.createCallId();
    this.setCallState('requesting');
    this.isMuted = false;
    this.isCameraOff = false;

    console.log(`[Call] Initiating ${type} call to peer: ${targetPeerId}`);

    // Request permissions early
    try {
      const constraints = {
        audio: true,
        video: type === 'video'
      };
      this.localStream = await this.acquireMediaStream(constraints);
    } catch (err) {
      console.error("[Call] Failed to acquire outgoing media:", err);
      if (err.message === "INSECURE_CONTEXT") {
        showToast("Calling requires a secure HTTPS or Localhost connection.", "error");
      } else {
        showToast("Access Denied: Camera or Microphone required.", "error");
      }
      this.resetState();
      return;
    }

    // A user may cancel while the browser permission prompt is open.
    if (this.callState !== 'requesting' || !this.callId) {
      this.localStream?.getTracks().forEach(track => track.stop());
      this.localStream = null;
      return;
    }

    // Show floating call view overlay
    this.setCallState('outgoing-ringing');
    this.updateUIForCallingState();

    // Synthesize call ringing indicator
    this.startRingingTone();

    // Signal remote target peer about outgoing call request
    BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
      type: 'offer-request',
      callId: this.callId,
      callType: this.callType // Use dynamic resolved callType (might have fallen back to voice)
    });

    this.clearIncomingTimeout();
    const activeCallId = this.callId;
    this.incomingTimeout = setTimeout(() => {
      if (this.callState === 'outgoing-ringing' && this.callId === activeCallId) {
        showToast('No answer. Call ended.', 'info');
        this.hangup(true);
      }
    }, 30000);
  }

  // ── Receive Incoming Call Request ──────────────────────────
  handleIncomingCallRequest(roomId, fromPeerId, signal) {
    const incomingCallId = signal.callId || this.createCallId();
    if (this.isCallInProgress()) {
      // Tell the new caller why the request cannot be shown. This prevents
      // callers from ringing forever when the recipient is already busy.
      BitMaskSocket.sendCallSignal(roomId, fromPeerId, {
        type: 'busy',
        callId: incomingCallId,
      });
      return;
    }

    this.roomId = roomId;
    this.targetPeerId = fromPeerId;
    this.callType = signal.callType || 'voice';
    this.callId = incomingCallId;
    this.setCallState('incoming');

    // Pulse incoming call sound
    this.startRingingTone();

    // Render incoming call overlay details with exact call type (Voice Call or Video Call)
    const modal = document.getElementById('incoming-call-modal');
    const callerSpan = document.getElementById('incoming-caller-id');
    const titleEl = document.getElementById('incoming-call-title');
    const avatarEl = document.getElementById('incoming-call-avatar');
    const descEl = document.getElementById('incoming-call-desc');

    const isVideo = this.callType === 'video';
    const typeLabel = isVideo ? 'Video Call' : 'Voice Call';
    const typeIcon = isVideo
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>'
      : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.1 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2.1Z"/></svg>';

    if (titleEl) {
      titleEl.textContent = `Incoming ${typeLabel}...`;
    }
    if (avatarEl) {
      avatarEl.innerHTML = typeIcon;
    }
    if (descEl) {
      descEl.innerHTML = `Peer <span id="incoming-caller-id">${fromPeerId.slice(0, 6)}...</span> is requesting an encrypted <strong>${typeLabel}</strong>.`;
    } else if (callerSpan) {
      callerSpan.textContent = fromPeerId.slice(0, 6) + '...';
    }

    if (modal) {
      modal.classList.remove('hidden');
    }

    this.clearIncomingTimeout();
    this.incomingTimeout = setTimeout(() => {
      if (this.callState === 'incoming' && this.callId === incomingCallId) {
        this.rejectIncomingCall('timeout');
      }
    }, 30000);
  }

  // ── Accept Incoming Call ───────────────────────────────────
  async acceptIncomingCall() {
    if (this.callState !== 'incoming' || !this.callId) return;
    this.stopRingingTone();
    this.clearIncomingTimeout();
    document.getElementById('incoming-call-modal').classList.add('hidden');
    this.setCallState('connecting');

    try {
      const constraints = {
        audio: true,
        video: this.callType === 'video'
      };
      this.localStream = await this.acquireMediaStream(constraints);
    } catch (err) {
      console.error("[Call] Failed to acquire incoming media:", err);
      if (err.message === "INSECURE_CONTEXT") {
        showToast("Calling requires a secure HTTPS or Localhost connection.", "error");
      } else {
        showToast("Access Denied: Camera or Microphone required.", "error");
      }
      this.rejectIncomingCall();
      return;
    }

    if (this.callState !== 'connecting' || !this.callId) {
      this.localStream?.getTracks().forEach(track => track.stop());
      this.localStream = null;
      return;
    }

    // Display frosted calling card overlay
    this.updateUIForCallingState();

    // Bind WebRTC connection peer logic
    this.setupPeerConnection();

    // Generate Offer Description
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
        type: 'offer',
        callId: this.callId,
        sdp: offer
      });
    } catch (err) {
      console.error("Failed to build WebRTC Offer:", err);
      this.hangup();
    }
  }

  // ── Reject Incoming Call ───────────────────────────────────
  rejectIncomingCall(reason = 'rejected') {
    this.stopRingingTone();
    this.clearIncomingTimeout();
    document.getElementById('incoming-call-modal').classList.add('hidden');

    if (this.roomId && this.targetPeerId && this.callId) {
      BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
        type: 'reject',
        callId: this.callId,
        reason,
      });
    }

    this.resetState();
  }

  // ── Setup Peer Connection & Streams ────────────────────────
  setupPeerConnection() {
    this.isCallActive = true;
    this.setCallState('connecting');
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    // Bind ICE candidates routing
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
          type: 'candidate',
          callId: this.callId,
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.callState === 'idle') return;
      const state = this.peerConnection?.connectionState;
      if (state === 'connected') {
        this.setCallState('connected');
        this.stopRingingTone();
        this.clearIncomingTimeout();
      } else if (['failed', 'disconnected', 'closed'].includes(state)) {
        this.hangup(state !== 'closed');
      }
    };

    // Bind remote tracks to remote video stream
    this.peerConnection.ontrack = (event) => {
      console.log("[Call] Remote stream track received.");
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
      }
    };

    // Attach local stream tracks to our Peer Connection
    this.localStream.getTracks().forEach((track) => {
      this.peerConnection.addTrack(track, this.localStream);
    });

    // Mirror local camera stream in small floating preview (if video)
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      if (this.callType === 'video') {
        localVideo.srcObject = this.localStream;
        localVideo.classList.remove('hidden');
      } else {
        localVideo.classList.add('hidden');
      }
    }
  }

  // ── Handle Relayed WebSocket Signals ───────────────────────
  async handleIncomingSignal(fromPeerId, signal) {
    if (fromPeerId !== this.targetPeerId) return;
    if (signal.callId && this.callId && signal.callId !== this.callId) return;
    if (signal.callId && !this.callId) this.callId = signal.callId;

    switch (signal.type) {
      case 'offer':
        console.log("[Call] WebRTC Offer signal received.");
        this.setupPeerConnection();
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);

          BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
            type: 'answer',
            callId: this.callId,
            sdp: answer
          });
        } catch (err) {
          console.error("Failed to answer incoming call SDP offer:", err);
          this.hangup();
        }
        break;

      case 'answer':
        console.log("[Call] WebRTC Answer signal received.");
        this.stopRingingTone();
        this.clearIncomingTimeout();
        if (this.peerConnection) {
          try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          } catch (err) {
            console.error("Failed to apply answer description:", err);
            this.hangup();
          }
        }
        break;

      case 'candidate':
        if (this.peerConnection) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch (err) {
            console.warn("Failed to add ICE candidate:", err);
          }
        }
        break;

      case 'reject':
        console.log("[Call] Ring request rejected by remote peer.");
        showToast(signal.reason === 'timeout' ? "Call timed out." : "Call declined by peer.", "info");
        this.hangup(false);
        break;

      case 'busy':
        showToast("Peer is already on another call.", "info");
        this.hangup(false);
        break;

      case 'cancel':
        showToast("Call canceled.", "info");
        this.resetState();
        break;

      case 'hangup':
        console.log("[Call] Peer hung up active connection.");
        showToast("Call ended.", "info");
        this.hangup(false);
        break;
    }
  }

  // ── Control Toggles ────────────────────────────────────────
  toggleMute() {
    if (!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isMuted;
    });

    const muteBtn = document.getElementById('call-mute-audio-btn');
    if (muteBtn) {
      if (this.isMuted) {
        muteBtn.classList.add('active');
        muteBtn.title = "Unmute Microphone";
      } else {
        muteBtn.classList.remove('active');
        muteBtn.title = "Mute Microphone";
      }
    }
    showToast(this.isMuted ? "Microphone muted" : "Microphone active", "info");
  }

  toggleCamera() {
    if (!this.localStream || this.callType !== 'video') return;
    this.isCameraOff = !this.isCameraOff;
    this.localStream.getVideoTracks().forEach((track) => {
      track.enabled = !this.isCameraOff;
    });

    const cameraBtn = document.getElementById('call-toggle-video-btn');
    const localVideo = document.getElementById('local-video');
    if (cameraBtn) {
      if (this.isCameraOff) {
        cameraBtn.classList.add('active');
        if (localVideo) localVideo.style.opacity = '0';
      } else {
        cameraBtn.classList.remove('active');
        if (localVideo) localVideo.style.opacity = '1';
      }
    }
    showToast(this.isCameraOff ? "Camera turned off" : "Camera turned on", "info");
  }

  // ── Tear Down Active Session ───────────────────────────────
  hangup(notifyRemote = true) {
    console.log("[Call] Hanging up call.");
    this.stopRingingTone();
    this.clearIncomingTimeout();

    if (notifyRemote && this.roomId && this.targetPeerId && this.callId) {
      const signalType = ['requesting', 'outgoing-ringing'].includes(this.callState) ? 'cancel' : 'hangup';
      BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
        type: signalType,
        callId: this.callId,
      });
    }

    this.resetState();
  }

  resetState() {
    this.stopRingingTone();
    this.clearIncomingTimeout();
    this.stopVoiceWaveAnimation();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Reset video player frames
    const remoteVideo = document.getElementById('remote-video');
    const localVideo = document.getElementById('local-video');
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;

    // Reset control overlay states
    const muteBtn = document.getElementById('call-mute-audio-btn');
    const cameraBtn = document.getElementById('call-toggle-video-btn');
    if (muteBtn) muteBtn.classList.remove('active');
    if (cameraBtn) cameraBtn.classList.remove('active');

    // Hide Calling card
    document.getElementById('call-overlay').classList.add('hidden');
    document.getElementById('incoming-call-modal').classList.add('hidden');

    this.roomId = null;
    this.targetPeerId = null;
    this.callType = null;
    this.callId = null;
    this.isCallActive = false;
    this.setCallState('idle');
    this.isMuted = false;
    this.isCameraOff = false;
  }

  handleTransportDisconnect() {
    this.resetState();
  }

  // ── Dynamic Call UI state managers ─────────────────────────
  updateUIForCallingState() {
    const overlay = document.getElementById('call-overlay');
    const peerSpan = document.getElementById('call-peer-name');
    const voiceAvatar = document.getElementById('voice-avatar');
    const cameraBtn = document.getElementById('call-toggle-video-btn');

    if (peerSpan) {
      peerSpan.textContent = this.targetPeerId.slice(0, 6) + '...';
    }

    if (this.callType === 'video') {
      if (voiceAvatar) voiceAvatar.classList.add('hidden');
      if (cameraBtn) cameraBtn.classList.remove('hidden');
      this.stopVoiceWaveAnimation();
    } else {
      if (voiceAvatar) voiceAvatar.classList.remove('hidden');
      if (cameraBtn) cameraBtn.classList.add('hidden'); // No camera toggles on audio voice calls
      this.startVoiceWaveAnimation();
    }

    if (overlay) {
      overlay.classList.remove('hidden');
    }
  }

  updateUIPostDowngrade() {
    const localVideo = document.getElementById('local-video');
    const voiceAvatar = document.getElementById('voice-avatar');
    const cameraBtn = document.getElementById('call-toggle-video-btn');

    if (localVideo) localVideo.classList.add('hidden');
    if (voiceAvatar) voiceAvatar.classList.remove('hidden');
    if (cameraBtn) cameraBtn.classList.add('hidden');
    this.startVoiceWaveAnimation();
  }

  // ── Siri-style animated glowing voice visualizer ──────────
  startVoiceWaveAnimation() {
    this.stopVoiceWaveAnimation();
    const canvas = document.getElementById('voice-wave-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let phase = 0;
    this.isWaveAnimating = true;

    canvas.width = 280;
    canvas.height = 80;

    const renderWave = () => {
      if (!this.isWaveAnimating) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const waves = [
        { amplitude: 18, frequency: 0.03, color: 'rgba(181, 234, 226, 0.55)', phaseOffset: 0 },
        { amplitude: 12, frequency: 0.05, color: 'rgba(79, 172, 254, 0.35)', phaseOffset: Math.PI / 2.5 },
        { amplitude: 8, frequency: 0.02, color: 'rgba(0, 255, 178, 0.3)', phaseOffset: -Math.PI / 3 }
      ];

      waves.forEach((w) => {
        ctx.beginPath();
        ctx.strokeStyle = w.color;
        ctx.lineWidth = w === waves[0] ? 3.5 : 1.5;
        ctx.shadowColor = w.color;
        ctx.shadowBlur = 12;

        for (let x = 0; x < canvas.width; x++) {
          const y = canvas.height / 2 + Math.sin(x * w.frequency + phase + w.phaseOffset) * w.amplitude;
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      });

      phase += 0.05;
      this.waveAnimationFrame = requestAnimationFrame(renderWave);
    };

    renderWave();
  }

  stopVoiceWaveAnimation() {
    this.isWaveAnimating = false;
    if (this.waveAnimationFrame) {
      cancelAnimationFrame(this.waveAnimationFrame);
      this.waveAnimationFrame = null;
    }
  }
}

// Instantiate Global Calling Module reference
window.BitMaskCall = new BitMaskCallController();
