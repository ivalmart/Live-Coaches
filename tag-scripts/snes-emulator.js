import { emulateSnesConsole } from "../SNES9x-framework/snes.mjs"; // Super Nintendo emulator import

// <snes-emulator> web component
class SnesEmulator extends HTMLElement {
  static get observedAttributes() {
    return ['rom-url', 'rom-name', 'state-url'];
  }
  constructor() {
    super();
    this.emulator = null;   // main emulator instance
    this.keyboardInputs = null; // mapping of controller inputs
    this.gamepadInputs = null;   // mapping of gamepad inputs
    this.gamepadSystemInputs = {
      fullscreen: {
        buttonIndices: [17], // Switch capture button
        held: false
      },
      captions: {
        buttonIndices: [6], // Switch ZL trigger
        held: false
      }
    };

    this.romName = null;    // name of ROM for exporting purposes
    this.romUrl = null;     // ROM url from local assets folder
    this.romBytes = null;   // transformed bytes of loaded ROM

    this.stateUrl = null;   // save state url from local assets folder (optional)
    this.stateBytes = null; // transformed bytes of loaded save state

    this.playerState = {}; // current player state information (note: might curently only focus on Super Metroid)
    this.lastCoachPushGameMinute = null; // absolute in-game minute when the last coach update was sent
    this.livenessEnvironments = new Set(["Live-Coach", "Liveness-Only"]);
    this.SAVE_SLOTS = new Array(10); // 10 save slots by default, will preload 4-9
    this._captionTimers = new Map();
    this.fullscreenCaptionsStorageKey = "LIVE_COACH_FULLSCREEN_CAPTIONS_ENABLED";
    this.fullscreenCaptionsEnabled = localStorage.getItem(this.fullscreenCaptionsStorageKey) === "true";
    this.recordingModeActive = false;
    this.systemActivityIndicatorState = {
      visible: false,
      text: "System is thinking..."
    };
    this._fullscreenSyncHandler = null;
    this._overlayClockIntervalId = null;
    this._overlayClockResizeHandler = null;
  }

  // called each time component is added onto document
  connectedCallback() {
    this.romUrl = this.getAttribute('rom-url');
    this.romName = this.getAttribute('rom-name');

    this.stateUrl = this.getAttribute('state-url');

    if (!this._fullscreenSyncHandler) {
      this._fullscreenSyncHandler = () => {
        this.applySystemActivityIndicator();
        this.positionCanvasBoundOverlays();
      };
      document.addEventListener('fullscreenchange', this._fullscreenSyncHandler);
      document.addEventListener('webkitfullscreenchange', this._fullscreenSyncHandler);
    }

    if (!this._overlayClockResizeHandler) {
      this._overlayClockResizeHandler = () => {
        this.positionCanvasBoundOverlays();
      };
      window.addEventListener('resize', this._overlayClockResizeHandler);
    }

    this.init();
  }

  disconnectedCallback() {
    this.stopOverlayClock();

    if (this._overlayClockResizeHandler) {
      window.removeEventListener('resize', this._overlayClockResizeHandler);
      this._overlayClockResizeHandler = null;
    }

    if (this._fullscreenSyncHandler) {
      document.removeEventListener('fullscreenchange', this._fullscreenSyncHandler);
      document.removeEventListener('webkitfullscreenchange', this._fullscreenSyncHandler);
      this._fullscreenSyncHandler = null;
    }
  }

  formatOverlayClockTime(date = new Date()) {
    return date.toLocaleTimeString([], {
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  updateOverlayClock() {
    const clockEl = this.querySelector('#overlay-clock');
    if (!clockEl) {
      return;
    }
    this.positionCanvasBoundOverlays();
    clockEl.textContent = this.formatOverlayClockTime();
  }

  positionCanvasBoundOverlays() {
    this.positionOverlayClock();
    this.positionRecordingModeOutline();
  }

  positionOverlayClock() {
    const clockEl = this.querySelector('#overlay-clock');
    const emuStyle = this.querySelector('.emu_style');
    const canvas = this.querySelector('canvas');
    if (!clockEl || !emuStyle || !canvas) {
      return;
    }

    const hostRect = emuStyle.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!hostRect.width || !hostRect.height || !canvasRect.width || !canvasRect.height) {
      return;
    }

    // Anchor inside the visible canvas area so the clock stays aligned during letterboxing/resizing.
    const horizontalPadding = Math.max(8, Math.round(canvasRect.width * 0.02));
    const verticalPadding = Math.max(8, Math.round(canvasRect.height * 0.02));
    const leftPx = Math.round(canvasRect.left - hostRect.left + horizontalPadding);
    const bottomPx = Math.round(hostRect.bottom - canvasRect.bottom + verticalPadding);

    clockEl.style.left = `${leftPx}px`;
    clockEl.style.top = 'auto';
    clockEl.style.right = 'auto';
    clockEl.style.bottom = `${bottomPx}px`;
  }

  positionRecordingModeOutline() {
    const overlay = this.querySelector('#recording-mode-outline');
    const emuStyle = this.querySelector('.emu_style');
    const canvas = this.querySelector('canvas');
    if (!overlay || !emuStyle || !canvas) {
      return;
    }

    const hostRect = emuStyle.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!hostRect.width || !hostRect.height || !canvasRect.width || !canvasRect.height) {
      return;
    }

    const leftPx = Math.round(canvasRect.left - hostRect.left);
    const topPx = Math.round(canvasRect.top - hostRect.top);
    const widthPx = Math.round(canvasRect.width);
    const heightPx = Math.round(canvasRect.height);

    overlay.style.left = `${leftPx}px`;
    overlay.style.top = `${topPx}px`;
    overlay.style.width = `${widthPx}px`;
    overlay.style.height = `${heightPx}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  startOverlayClock() {
    this.updateOverlayClock();
    this.stopOverlayClock();
    this._overlayClockIntervalId = window.setInterval(() => {
      this.updateOverlayClock();
    }, 1000);
  }

  stopOverlayClock() {
    if (this._overlayClockIntervalId === null) {
      return;
    }
    clearInterval(this._overlayClockIntervalId);
    this._overlayClockIntervalId = null;
  }

  // ----- First instance of SNES Emulator creation -----
  async init() {
    this.render();
    this.startOverlayClock();
    this.broadcastFullscreenCaptionsState();
    if (!this.romUrl) {
      return;
    }

    this.romBytes = await this.loadBinary(this.romUrl);
    try {
      this.stateBytes = this.stateUrl ? await this.loadBinary(this.stateUrl) : null;
    } catch (e) {
      this.stateBytes = null;
    }

    this.initEmulator();
    this.initAudioControls();
    this.initGameControls();
    this.initExportImport();
    await this.initSaveStates();
    this.playerState = this.retrievePlayerState();
    this.positionCanvasBoundOverlays();
  }

  async loadBinary(url) {
    let response = await fetch(url);
    return new Uint8Array(await response.arrayBuffer());
  }

  // Toggle mute/unmute on the game audio GainNode
  initAudioControls() {
    this.muted = false;
  }

  toggleMute() {
    if (!this.emulator || !this.emulator.gainNode) return;
    this.muted = !this.muted;
    this.emulator.gainNode.gain.value = this.muted ? 0 : 1;
  }

  toggleFullscreen(canvas) {
    const fullscreenHost = this.querySelector('.emu_style') || canvas;
    if (!fullscreenHost) {
      return;
    }
    if (!document.fullscreenElement) {
      fullscreenHost.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  isInFullscreenMode() {
    const fullscreenElement = document.fullscreenElement;
    if (!fullscreenElement) {
      return false;
    }
    return fullscreenElement === this || this.contains(fullscreenElement) || fullscreenElement.contains(this);
  }

  clearCaptionTimers(captionKey) {
    const timers = this._captionTimers.get(captionKey);
    if (!timers) {
      return;
    }
    if (timers.fadeTimer) {
      clearTimeout(timers.fadeTimer);
    }
    if (timers.removeTimer) {
      clearTimeout(timers.removeTimer);
    }
    this._captionTimers.delete(captionKey);
  }

  clearFullscreenCaptions() {
    const captionLayer = this.querySelector('#fullscreen-caption-layer');
    if (!captionLayer) {
      return;
    }

    captionLayer.querySelectorAll('[data-caption-key]').forEach((captionEl) => {
      if (captionEl.dataset && captionEl.dataset.captionKey) {
        this.clearCaptionTimers(captionEl.dataset.captionKey);
      }
      captionEl.remove();
    });
  }

  broadcastFullscreenCaptionsState() {
    window.dispatchEvent(new CustomEvent('live-coach-fullscreen-captions-changed', {
      detail: { enabled: this.fullscreenCaptionsEnabled }
    }));
  }

  getFullscreenCaptionsEnabled() {
    return this.fullscreenCaptionsEnabled;
  }

  setFullscreenCaptionsEnabled(enabled) {
    this.fullscreenCaptionsEnabled = !!enabled;
    localStorage.setItem(
      this.fullscreenCaptionsStorageKey,
      this.fullscreenCaptionsEnabled ? 'true' : 'false'
    );

    if (!this.fullscreenCaptionsEnabled) {
      this.clearFullscreenCaptions();
    }

    this.broadcastFullscreenCaptionsState();
    return this.fullscreenCaptionsEnabled;
  }

  toggleFullscreenCaptions() {
    return this.setFullscreenCaptionsEnabled(!this.fullscreenCaptionsEnabled);
  }

  scheduleCaptionDismiss(captionEl, captionKey, lingerMs) {
    if (!captionEl || !captionEl.parentNode) {
      return;
    }

    this.clearCaptionTimers(captionKey);
    const safeLingerMs = Math.max(0, Number(lingerMs) || 0);
    const fadeDelay = Math.max(0, safeLingerMs - 400);

    const fadeTimer = window.setTimeout(() => {
      captionEl.classList.add('fade-out');
    }, fadeDelay);

    const removeTimer = window.setTimeout(() => {
      if (captionEl.parentNode) {
        captionEl.parentNode.removeChild(captionEl);
      }
      this._captionTimers.delete(captionKey);
    }, safeLingerMs);

    this._captionTimers.set(captionKey, { fadeTimer, removeTimer });
  }

  showFullscreenCaption({ speaker, text, captionKey, lingerMs = 3000, holdUntilDismiss = false }) {
    if (!this.fullscreenCaptionsEnabled || !this.isInFullscreenMode()) {
      return;
    }

    const captionLayer = this.querySelector('#fullscreen-caption-layer');
    if (!captionLayer || !text) {
      return;
    }

    const resolvedKey = captionKey || `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let caption = captionLayer.querySelector(`[data-caption-key="${resolvedKey}"]`);
    if (!caption) {
      caption = document.createElement('div');
      caption.className = 'fullscreen-caption';
      caption.dataset.captionKey = resolvedKey;
      captionLayer.appendChild(caption);
    }

    caption.classList.remove('fade-out', 'player-caption', 'coach-caption');
    caption.classList.add(speaker === 'Coach' ? 'coach-caption' : 'player-caption');
    caption.textContent = `${speaker}: ${text}`;

    while (captionLayer.children.length > 2) {
      const oldestCaption = captionLayer.firstChild;
      if (oldestCaption && oldestCaption.dataset && oldestCaption.dataset.captionKey) {
        this.clearCaptionTimers(oldestCaption.dataset.captionKey);
      }
      captionLayer.removeChild(oldestCaption);
    }

    if (holdUntilDismiss) {
      this.clearCaptionTimers(resolvedKey);
      return resolvedKey;
    }

    this.scheduleCaptionDismiss(caption, resolvedKey, lingerMs);
    return resolvedKey;
  }

  dismissFullscreenCaption(captionKey, lingerMs = 1000) {
    if (!captionKey) {
      return;
    }
    const captionLayer = this.querySelector('#fullscreen-caption-layer');
    if (!captionLayer) {
      return;
    }

    const caption = captionLayer.querySelector(`[data-caption-key="${captionKey}"]`);
    if (!caption) {
      return;
    }

    this.scheduleCaptionDismiss(caption, captionKey, lingerMs);
  }

  setSystemActivityIndicator({ visible, text = "System is thinking..." } = {}) {
    this.systemActivityIndicatorState.visible = !!visible;
    this.systemActivityIndicatorState.text = text || "System is thinking...";
    this.applySystemActivityIndicator();
  }

  applySystemActivityIndicator() {
    const indicator = this.querySelector('#fullscreen-system-indicator');
    if (!indicator) {
      return;
    }

    const shouldShow = !!this.systemActivityIndicatorState.visible && this.isInFullscreenMode();
    const textNode = indicator.querySelector('.fullscreen-system-indicator-text');
    if (textNode && this.systemActivityIndicatorState.text) {
      textNode.textContent = this.systemActivityIndicatorState.text;
    }

    indicator.classList.toggle('visible', shouldShow);
    indicator.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  setRecordingModeActive(isActive) {
    this.recordingModeActive = !!isActive;
    const overlay = this.querySelector('#recording-mode-outline');
    if (!overlay) {
      return;
    }
    this.positionRecordingModeOutline();
    overlay.classList.toggle('active', this.recordingModeActive);
    overlay.setAttribute('aria-hidden', this.recordingModeActive ? 'false' : 'true');
  }

  captureCoachScreenshot({ detailLevel = "normal" } = {}) {
    const sourceCanvas = this.querySelector("canvas");
    if (!sourceCanvas) {
      return { ok: false, error: "Emulator canvas not available." };
    }

    const sourceWidth = Number(sourceCanvas.width || sourceCanvas.clientWidth || 0);
    const sourceHeight = Number(sourceCanvas.height || sourceCanvas.clientHeight || 0);
    if (!sourceWidth || !sourceHeight) {
      return { ok: false, error: "Emulator canvas has invalid dimensions." };
    }

    const detailProfile = detailLevel === "detailed"
      ? { maxDimension: 512, maxBytes: 550 * 1024 }
      : { maxDimension: 384, maxBytes: 350 * 1024 };

    const scale = Math.min(1, detailProfile.maxDimension / Math.max(sourceWidth, sourceHeight));
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

    const scaledCanvas = document.createElement("canvas");
    scaledCanvas.width = targetWidth;
    scaledCanvas.height = targetHeight;

    const context = scaledCanvas.getContext("2d");
    if (!context) {
      return { ok: false, error: "Unable to create screenshot rendering context." };
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

    const estimateBytes = (dataUrl) => {
      const commaIndex = dataUrl.indexOf(",");
      if (commaIndex === -1) {
        return 0;
      }
      return Math.ceil(((dataUrl.length - commaIndex - 1) * 3) / 4);
    };

    const getMimeTypeFromDataUrl = (dataUrl, fallbackMimeType) => {
      const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/i);
      return mimeMatch && mimeMatch[1] ? mimeMatch[1] : fallbackMimeType;
    };

    const pickBestEncoding = () => {
      const candidates = [
        { mimeType: "image/png" },
        { mimeType: "image/webp", quality: 0.82 },
        { mimeType: "image/jpeg", quality: 0.78 },
      ];

      let smallest = null;
      for (const candidate of candidates) {
        const dataUrl = scaledCanvas.toDataURL(candidate.mimeType, candidate.quality);
        const estimatedBytes = estimateBytes(dataUrl);
        const result = {
          dataUrl,
          mimeType: getMimeTypeFromDataUrl(dataUrl, candidate.mimeType),
          byteLength: estimatedBytes,
        };
        if (!smallest || estimatedBytes < smallest.byteLength) {
          smallest = result;
        }
        if (estimatedBytes <= detailProfile.maxBytes) {
          return result;
        }
      }

      return smallest;
    };

    const encodedScreenshot = pickBestEncoding();
    if (!encodedScreenshot || !encodedScreenshot.dataUrl) {
      return { ok: false, error: "Failed to encode screenshot." };
    }

    const encodedParts = encodedScreenshot.dataUrl.split(",", 2);
    if (encodedParts.length !== 2) {
      return { ok: false, error: "Screenshot encoding format was invalid." };
    }

    return {
      ok: true,
      detailLevel,
      width: targetWidth,
      height: targetHeight,
      mimeType: encodedScreenshot.mimeType,
      byteLength: encodedScreenshot.byteLength,
      data: encodedParts[1],
      wasDownscaled: scale < 1,
    };
  }

  // Utility for app-level gamepad actions that are not SNES inputs.
  isAnyGamepadButtonPressed(gamepad, buttonIndices) {
    if (!gamepad || !gamepad.buttons) {
      return false;
    }
    return buttonIndices.some((buttonIndex) => gamepad.buttons[buttonIndex] && gamepad.buttons[buttonIndex].pressed);
  }

  // Initialize emulator using snes.mjs functions
  initEmulator() {
    this.emulator = window.emulator = emulateSnesConsole(
      this.romBytes,
      this.stateBytes,
      this.querySelector('#emulator')
    );
  }

  initGameControls() {
    // ----- External Gamepad Controller of SNES controller (Switch Pro Controller scheme) -----
    // Gamepad API https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API
    // ONLY for gamepad inputs appropriate for the game emulator, set of other buttons are NOT included in here (e.g., fullscreen and captions toggle)
    this.gamepadInputs = {
      0: 0,   // A button
      1: 2,   // X button
      2: 8,   // Select button
      3: 9,   // Start button
      4: 12,  // Up on D-pad
      5: 13,  // Down on D-pad
      6: 14,  // Left on D-pad
      7: 15,  // Right on D-pad
      8: 1,   // B button
      9: 3,   // Y button
      10: 4,  // Left bumper trigger
      11: 5   // Right bumper trigger
    };
    this.checkGamepadInput = this.checkGamepadInput.bind(this);
    requestAnimationFrame(this.checkGamepadInput);

    // ----- Keyboard mapping of SNES controller -----
    this.keyboardInputs = [
      { key: "l", value: "A" }, // A button, 0
      { key: "k", value: "X" }, // X button, 1
      { key: "Shift", value: "Select" }, // Select button, 2
      { key: "Enter", value: "Start" }, // Start button, 3
      { key: "w", value: "Up" }, // Up button, 4
      { key: "s", value: "Down" }, // Down button, 5
      { key: "a", value: "Left" }, // Left button, 6
      { key: "d", value: "Right" }, // Right button, 7
      { key: "p", value: "B" }, // B button, 8
      { key: "o", value: "Y" }, // Y button, 9
      { key: "q", value: "LeftTrigger" }, // Left bumper, 10
      { key: "e", value: "RightTrigger" }, // Right bumper, 11
    ];

    // Pressing keyboard events
    const canvas = this.querySelector('canvas');
    canvas.addEventListener('keydown', e => {
      if (e.key === 'f' || e.key === 'F') {
        this.toggleFullscreen(canvas);
        e.preventDefault();
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        this.toggleMute();
        e.preventDefault();
        return;
      }
      // overall game controls
      const index = this.findGameInputIndex(e.key);
      const keyState = `0,1,0,${index}`;
      if (index !== -1) {
        this.emulator.input_state[keyState] = 1;
      }
    });

    // Releasing keyboard events
    canvas.addEventListener('keyup', e => {
      const index = this.findGameInputIndex(e.key);
      const keyState = `0,1,0,${index}`;
      if (index !== -1) {
        this.emulator.input_state[keyState] = 0;
      }
    });

    // Focus canvas for keyboard qol
    canvas.setAttribute('tabindex', 0);
    canvas.addEventListener('click', () => canvas.focus());
  }

  // Helper function to find index of controller input based on keyboard input
  findGameInputIndex(key) {
    return this.keyboardInputs.findIndex((button) => button.key === key);
  }

  // Constantly checking the connected gamepad mapping to how the SNES controller is set up
  // Navigator Gamepad documentation: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getGamepads
  checkGamepadInput() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (!this.emulator || !gamepads) {
      requestAnimationFrame(this.checkGamepadInput);
      return;
    }

    // gamepads variable stores up to 4 connected controllers, We only care about 1 gamepad for now
    // Gamepad index 0, first controller connected
    // WATCH OUT IN CASE CONTROLLER IS INDEX 1
    if(gamepads[0]) {
      // Map gamepad buttons to SNES controller in emultoar
      Object.entries(this.gamepadInputs).forEach(([snesIndex, gamepadBtnIndex]) => {
        const keyState = `0,1,0,${snesIndex}`;
        const pressed = gamepads[0].buttons[gamepadBtnIndex] && gamepads[0].buttons[gamepadBtnIndex].pressed;
        this.emulator.input_state[keyState] = pressed ? 1 : 0;
      });

      // Map gamepad buttons to UI outside of the game emulator
      const fullscreenControl = this.gamepadSystemInputs.fullscreen;
      const fullscreenPressed = this.isAnyGamepadButtonPressed(gamepads[0], fullscreenControl.buttonIndices);
      if (fullscreenPressed && !fullscreenControl.held) {
        this.toggleFullscreen(this.querySelector('canvas'));
        fullscreenControl.held = true;
      } else if (!fullscreenPressed) {
        fullscreenControl.held = false;
      }

      const captionsControl = this.gamepadSystemInputs.captions;
      const captionsPressed = this.isAnyGamepadButtonPressed(gamepads[0], captionsControl.buttonIndices);
      if (captionsPressed && !captionsControl.held) {
        this.toggleFullscreenCaptions();
        captionsControl.held = true;
      } else if (!captionsPressed) {
        captionsControl.held = false;
      }
    } else {
      this.gamepadSystemInputs.fullscreen.held = false;
      this.gamepadSystemInputs.captions.held = false;
    }
    requestAnimationFrame(this.checkGamepadInput);
  }

  // ----- Handling Load/Save state functionality -----
  initExportImport() {
    // Export state
    this.querySelector('#export').onclick = () => {
      this.exportSaveState();
    };
    // Import state
    this.querySelector('#import').onclick = () => {
      this.importSaveState();
    };
  }
  exportSaveState() {
    if (!this.emulator) {
      return;
    }
    const buffer = this.emulator.retro.serialize();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.romName}.state`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }
  importSaveState() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.state,application/octet-stream';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) {
        return;
      }
      const arr = new Uint8Array(await file.arrayBuffer());
      try {
        this.emulator.retro.unserialize(arr);
      } catch (err) {
        alert('Failed to load state: ' + err);
      }
    };
    input.click();
  }

  async initSaveStates() {
    this.SAVE_SLOTS[4] = await this.loadBinary(
      "../assets/sm_save_states/nextdoor-saveroom.state"
    );
    this.SAVE_SLOTS[5] = await this.loadBinary(
      "../assets/sm_save_states/pre-morphball.state"
    );
    this.SAVE_SLOTS[6] = await this.loadBinary(
      "../assets/sm_save_states/beginning_ship.state"
    );
    this.SAVE_SLOTS[7] = await this.loadBinary(
      "../assets/sm_save_states/morph_ball_achieved.state"
    );
    this.SAVE_SLOTS[8] = await this.loadBinary(
      "../assets/sm_save_states/missiles_achieved.state"
    );
    this.SAVE_SLOTS[9] = await this.loadBinary(
      "../assets/sm_save_states/enemy_encounter.state"
    );
  }

  // Handling DataView for game memory reading and manipulation.
  // get_memory_data(2) = RETRO_MEMORY_SYSTEM_RAM = SNES WRAM (128KB).
  // We read the full 128KB so we can access boss/event flags at $D820+.
  callDataView() {
    if (!this.emulator || !this.emulator.retro) {
      return;
    }
    try {
      let dv = new DataView(
        this.emulator.retro.get_memory_data(2).slice(0, 0x20000).buffer
      );
      return dv
    } catch (e) {
      // Optionally handle error
    }
  }

  // ----- Player State Functionality -----
  getAbsoluteGameMinute(hours = 0, minutes = 0) {
    return (Number(hours) * 60) + Number(minutes);
  }

  getComparablePlayerState(playerState = {}) {
    const { gameTimeHours, gameTimeMinutes, ...rest } = playerState;
    return rest;
  }

  isCurrentEnvironmentLivenessEnabled() {
    const urlParams = new URLSearchParams(window.location.search);
    const currentEnvironment = urlParams.get('Env');
    return this.livenessEnvironments.has(currentEnvironment);
  }

  // ──────────────────────────────────────────────────────────────────
  // SNES WRAM-to-item-name mappings.
  //
  // Upstream source: sm_rando/abstraction_validation/abstractify.py
  // (item_bits, beam_bits, boss_info, abstractify_boss_info).
  // Hardware docs: Kejardon's RAMMap, PAR Codes (GameFAQs, guard_master).
  //
  // Names match what the route server accepts (GET /items on the route
  // server). The route server translates these to sm_rando abbreviations
  // internally (e.g. "Morph" -> "MB").
  // ──────────────────────────────────────────────────────────────────

  // $7E:09A4 (16-bit LE): collected equipment bitmask.
  // Upstream: abstractify.py item_bits
  static WRAM_09A4_BIT_TO_ITEM = {
    0:  "Varia_Suit",     // 0x0001
    1:  "Spring_Ball",    // 0x0002
    2:  "Morph",          // 0x0004
    3:  "Screw_Attack",   // 0x0008
    // 4: unused
    5:  "Gravity_Suit",   // 0x0020
    // 6, 7: unused
    8:  "Hi_Jump",        // 0x0100
    9:  "Space_Jump",     // 0x0200
    // 10, 11: unused
    12: "Bombs",          // 0x1000
    13: "Speed_Booster",  // 0x2000
    14: "Grapple_Beam",   // 0x4000
    15: "XRay",           // 0x8000
  };

  // $7E:09A8 (16-bit LE): collected beams bitmask.
  // Upstream: abstractify.py beam_bits
  // Note: Charge Beam is bit 12 (0x1000), not in the low byte.
  static WRAM_09A8_BIT_TO_BEAM = {
    0:  "Wave_Beam",      // 0x0001
    1:  "Ice_Beam",       // 0x0002
    2:  "Spazer",         // 0x0004
    3:  "Plasma_Beam",    // 0x0008
    12: "Charge_Beam",    // 0x1000
  };

  // $7E:D828..D82E: boss defeat bits, one byte per area.
  // Indexed by area ID ($7E:079F). Bit 0 = area boss, bit 1 = miniboss,
  // bit 2 = torizo.
  // Upstream: abstractify.py boss_info dict
  //
  // Area 0 (Crateria/$D828): Bomb_Torizo at bit 2, but sm_rando doesn't
  //   model it as a Boss node, so we skip it (route server ignores it).
  // Area 6 (Ceres/$D82E): Ceres_Ridley at bit 0, also skipped.
  static WRAM_BOSS_FLAGS = [
    // [address, bit, name]
    [0xD829, 0, "Kraid"],          // Brinstar boss
    [0xD829, 1, "Spore_Spawn"],    // Brinstar miniboss
    [0xD82A, 0, "Ridley"],         // Norfair boss
    [0xD82A, 1, "Crocomire"],      // Norfair miniboss
    [0xD82A, 2, "Golden_Torizo"],  // Norfair torizo
    [0xD82B, 0, "Phantoon"],       // Wrecked Ship boss
    [0xD82C, 0, "Draygon"],        // Maridia boss
    [0xD82C, 1, "Botwoon"],        // Maridia miniboss
    [0xD82D, 1, "Mother_Brain"],   // Tourian miniboss (yes, miniboss slot)
  ];

  // $7E:D821: event flags byte.
  // Upstream: abstractify.py abstractify_boss_info, lines 72-75
  static WRAM_EVENT_FLAGS = [
    // [address, mask, name]
    [0xD821, 0x04, "Statues"],   // bit 2: Golden Statues sunk (Tourian access)
    [0xD821, 0x10, "Drain"],     // bit 4: Lower Norfair acid/lava lowered
    [0xD821, 0x20, "Shaktool"],  // bit 5: Shaktool cleared sand path
  ];

  // Ammo addresses: max count stored as 16-bit LE.
  // If max > 0, the player has that ammo type.
  // Upstream: abstractify.py abstractify_items, lines 89-108
  static WRAM_AMMO = [
    // [address, name]
    [0x09C8, "Missiles"],        // max missiles
    [0x09CC, "Super_Missiles"],  // max supers
    [0x09CE, "Power_Bombs"],     // max power bombs
  ];

  // Energy: max energy at $09C4 (16-bit LE). If > 99, player has an
  // Energy Tank. Reserve Tanks at $09D4.
  // Upstream: abstractify.py abstractify_items, lines 104-108

  retrievePlayerState() {
    if(this.romName == "SuperMetroid") {
      const dv = this.callDataView();
      const map_closestNode = document.querySelector('sm-map').player.closestNode;
      const state = {
        energy: dv.getUint8(0x09C2),
        missiles: dv.getUint8(0x09C6),
        inventory: this.getFullInventory(dv),
        closestNode: map_closestNode,
        gameTimeHours: dv.getUint16(0x09E0, true),
        gameTimeMinutes: dv.getUint16(0x09DE, true),
      };

      // Detect collected-but-unequipped items.
      // $09A2/$09A6 = currently equipped; $09A4/$09A8 = collected.
      // Same bit layouts. Only equipment and beams can be toggled;
      // ammo, bosses, and progress flags have no equipped/unequipped state.
      const unequipped = this.getUnequippedItems(dv);
      if (unequipped.length > 0) {
        state.unequipped = unequipped;
      }

      return state;
    }
  }

  /**
   * Read all state flags the route server needs: equipment, beams,
   * ammo-based items, boss defeats, and progress flags.
   *
   * Returns an array of name strings matching the route server's
   * vocabulary (GET /items). This is the full state vector the BDD
   * policy conditions on.
   */
  getFullInventory(dv) {
    const names = [];

    // Equipment bitmask: $09A4 (16-bit LE)
    const equip = dv.getUint16(0x09A4, true);
    for (const [bit, name] of Object.entries(this.constructor.WRAM_09A4_BIT_TO_ITEM)) {
      if (equip & (1 << Number(bit))) names.push(name);
    }

    // Beam bitmask: $09A8 (16-bit LE)
    const beams = dv.getUint16(0x09A8, true);
    for (const [bit, name] of Object.entries(this.constructor.WRAM_09A8_BIT_TO_BEAM)) {
      if (beams & (1 << Number(bit))) names.push(name);
    }

    // Ammo-based items: binary have/don't-have from max count > 0
    for (const [addr, name] of this.constructor.WRAM_AMMO) {
      if (dv.getUint16(addr, true) > 0) names.push(name);
    }

    // Energy Tank: max energy > 99 means at least one E-Tank
    if (dv.getUint16(0x09C4, true) > 99) names.push("Energy_Tank");

    // Reserve Tank: max reserve > 0
    if (dv.getUint16(0x09D4, true) > 0) names.push("Reserve_Tank");

    // Boss defeat flags: $D828..D82E, one byte per area
    for (const [addr, bit, name] of this.constructor.WRAM_BOSS_FLAGS) {
      if (dv.getUint8(addr) & (1 << bit)) names.push(name);
    }

    // Event/progress flags: $D821
    for (const [addr, mask, name] of this.constructor.WRAM_EVENT_FLAGS) {
      if (dv.getUint8(addr) & mask) names.push(name);
    }

    return names;
  }

  /**
   * Compare equipped ($09A2/$09A6) vs collected ($09A4/$09A8) bitmasks
   * and return names of items the player has collected but not equipped.
   *
   * Only equipment and beams can be toggled in the menu. Ammo, bosses,
   * and progress flags don't have an equipped/unequipped distinction.
   *
   * WRAM layout (same bit positions, different addresses):
   *   $09A2 = equipped items,  $09A4 = collected items
   *   $09A6 = equipped beams,  $09A8 = collected beams
   */
  getUnequippedItems(dv) {
    const unequipped = [];

    const collected = dv.getUint16(0x09A4, true);
    const equipped  = dv.getUint16(0x09A2, true);
    const disabledEquip = collected & ~equipped;
    for (const [bit, name] of Object.entries(this.constructor.WRAM_09A4_BIT_TO_ITEM)) {
      if (disabledEquip & (1 << Number(bit))) unequipped.push(name);
    }

    const collectedBeams = dv.getUint16(0x09A8, true);
    const equippedBeams  = dv.getUint16(0x09A6, true);
    const disabledBeams = collectedBeams & ~equippedBeams;
    for (const [bit, name] of Object.entries(this.constructor.WRAM_09A8_BIT_TO_BEAM)) {
      if (disabledBeams & (1 << Number(bit))) unequipped.push(name);
    }

    return unequipped;
  }

  updatePlayerState() {
    const newState = this.retrievePlayerState();
    if (!newState) {
      return;
    }

    const previousState = this.playerState || {};
    const hasAnyStateChange = JSON.stringify(newState) !== JSON.stringify(previousState);
    if (!hasAnyStateChange) {
      return;
    }

    this.playerState = newState;

    // Ablation study: only auto-push state in liveness-enabled environments.
    if (!this.isCurrentEnvironmentLivenessEnabled()) {
      return;
    }

    // Secondary guard from <live-coach> settings for safety.
    const liveCoach = document.querySelector('live-coach');
    if (!(liveCoach && liveCoach.ablationSettings.liveness)) {
      return;
    }

    const comparableNew = this.getComparablePlayerState(newState);
    const comparablePrevious = this.getComparablePlayerState(previousState);
    const hasNonTimeStateChange = JSON.stringify(comparableNew) !== JSON.stringify(comparablePrevious);

    const currentAbsoluteMinute = this.getAbsoluteGameMinute(
      newState.gameTimeHours,
      newState.gameTimeMinutes
    );

    if (this.lastCoachPushGameMinute !== null && currentAbsoluteMinute < this.lastCoachPushGameMinute) {
      // Save-state loads can move game time backwards. Reset the baseline so the inactivity timer remains sane.
      this.lastCoachPushGameMinute = currentAbsoluteMinute;
    }

    const elapsedSinceLastCoachPush = this.lastCoachPushGameMinute === null
      ? Number.POSITIVE_INFINITY
      : currentAbsoluteMinute - this.lastCoachPushGameMinute;
    const reachedInactivityThreshold = elapsedSinceLastCoachPush >= 2; // 2 minute timer

    if (hasNonTimeStateChange || reachedInactivityThreshold) {
      liveCoach.sendChatMessage({ to: "Coach", from: "Game", text: JSON.stringify(this.playerState) });
      this.lastCoachPushGameMinute = currentAbsoluteMinute;
    }
  }

  // get_set_bits_from_packed_value removed: inventory is now returned as
  // item/boss/progress name strings by getFullInventory(), not as bit
  // indices. The route server accepts these names directly.

  // ----- HTML Structure of SNES-Emulator web component -----
  render() {
    this.innerHTML = `
      <link rel="stylesheet" href="../style.css"/>
      <div class="emu_style">
        <div style="display: none;">
          <button id="export">Export State</button>
          <button id="import">Import State</button>
        </div>
        <div id="emulator"></div>
        <div id="overlay-clock" aria-label="Current time"></div>
        <div id="fullscreen-caption-layer" aria-live="polite" aria-atomic="false"></div>
        <div id="fullscreen-system-indicator" aria-live="polite" aria-atomic="true" aria-hidden="true">
          <span class="fullscreen-system-indicator-dot" aria-hidden="true"></span>
          <span class="fullscreen-system-indicator-text">System is thinking...</span>
        </div>
        <div id="recording-mode-outline" aria-hidden="true"></div>
      </div>
    `;
  }
}
customElements.define('snes-emulator', SnesEmulator);
