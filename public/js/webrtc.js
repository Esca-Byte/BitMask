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
    if (this.isCallActive) return;

    this.roomId = roomId;
    this.targetPeerId = targetPeerId;
    this.callType = type;
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

    // Show floating call view overlay
    this.updateUIForCallingState();

    // Synthesize call ringing indicator
    this.startRingingTone();

    // Signal remote target peer about outgoing call request
    BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
      type: 'offer-request',
      callType: this.callType // Use dynamic resolved callType (might have fallen back to voice)
    });
  }

  // ── Receive Incoming Call Request ──────────────────────────
  handleIncomingCallRequest(roomId, fromPeerId, signal) {
    if (this.isCallActive) {
      // Auto-decline if already in a call
      BitMaskSocket.sendCallSignal(roomId, fromPeerId, { type: 'reject' });
      return;
    }

    this.roomId = roomId;
    this.targetPeerId = fromPeerId;
    this.callType = signal.callType;

    // Pulse incoming call sound
    this.startRingingTone();

    // Render incoming call overlay details
    const modal = document.getElementById('incoming-call-modal');
    const callerSpan = document.getElementById('incoming-caller-id');
    if (modal && callerSpan) {
      callerSpan.textContent = fromPeerId.slice(0, 6) + '...';
      modal.classList.remove('hidden');
    }
  }

  // ── Accept Incoming Call ───────────────────────────────────
  async acceptIncomingCall() {
    this.stopRingingTone();
    document.getElementById('incoming-call-modal').classList.add('hidden');

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
        sdp: offer
      });
    } catch (err) {
      console.error("Failed to build WebRTC Offer:", err);
      this.hangup();
    }
  }

  // ── Reject Incoming Call ───────────────────────────────────
  rejectIncomingCall() {
    this.stopRingingTone();
    document.getElementById('incoming-call-modal').classList.add('hidden');

    BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, { type: 'reject' });

    this.resetState();
  }

  // ── Setup Peer Connection & Streams ────────────────────────
  setupPeerConnection() {
    this.isCallActive = true;
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    // Bind ICE candidates routing
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, {
          type: 'candidate',
          candidate: event.candidate
        });
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
        showToast("Call declined by peer.", "info");
        this.hangup(false);
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

    if (notifyRemote && this.roomId && this.targetPeerId) {
      BitMaskSocket.sendCallSignal(this.roomId, this.targetPeerId, { type: 'hangup' });
    }

    this.resetState();
  }

  resetState() {
    this.stopRingingTone();
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
    this.isCallActive = false;
    this.isMuted = false;
    this.isCameraOff = false;
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
        { amplitude: 18, frequency: 0.03, color: 'rgba(0, 242, 254, 0.55)', phaseOffset: 0 },
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
