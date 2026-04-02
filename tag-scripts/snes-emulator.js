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
      }
    };

    this.romName = null;    // name of ROM for exporting purposes
    this.romUrl = null;     // ROM url from local assets folder
    this.romBytes = null;   // transformed bytes of loaded ROM

    this.stateUrl = null;   // save state url from local assets folder (optional)
    this.stateBytes = null; // transformed bytes of loaded save state

    this.playerState = {}; // current player state information (note: might curently only focus on Super Metroid)
    this.SAVE_SLOTS = new Array(10); // 10 save slots by default, will preload 4-9
    this._captionTimers = new Map();
  }

  // called each time component is added onto document
  connectedCallback() {
    this.romUrl = this.getAttribute('rom-url');
    this.romName = this.getAttribute('rom-name');

    this.stateUrl = this.getAttribute('state-url');
    this.init();
  }

  // ----- First instance of SNES Emulator creation -----
  async init() {
    this.render();
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
    if (!this.isInFullscreenMode()) {
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
    // ONLY for gamepad inputs appropriate for the game emulator, set of other buttons are NOT included in here (e.g., fullscreen and mic toggle)
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
    } else {
      this.gamepadSystemInputs.fullscreen.held = false;
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

  // Handling DataView for game memory reading and manipulation
  callDataView() {
    if (!this.emulator || !this.emulator.retro) {
      return;
    }
    try {
      let dv = new DataView(
        this.emulator.retro.get_memory_data(2).slice(0, 0x2000).buffer
      );
      return dv
    } catch (e) {
      // Optionally handle error
    }
  }

  // ----- Player State Functionality -----
  retrievePlayerState() {
    if(this.romName == "SuperMetroid") {
      const dv = this.callDataView();
      const map_closestNode = document.querySelector('sm-map').player.closestNode;
      // const smMapEl = document.querySelector('sm-map');
      // const map_closestNode = smMapEl && smMapEl.player ? smMapEl.player.closestNode : null;
      return {
        energy: dv.getUint8(0x09C2),
        missiles: dv.getUint8(0x09C6),
        inventory: this.get_set_bits_from_packed_value({ packed_value: dv.getUint16(0x09A4, true) }),
        closestNode: map_closestNode,
        gameTimeHours: dv.getUint16(0x09E0, true),   // $09E0: game time hours (0-99)
        gameTimeMinutes: (() => {
          const GRANULARITY = 2; // minutes — increase to coarsen how often the coach sees a timer change
          return Math.floor(dv.getUint16(0x09DE, true) / GRANULARITY) * GRANULARITY;
        })(),
      };
    }
  }
  updatePlayerState() {
    const newState = this.retrievePlayerState();
    if( JSON.stringify(newState) !== JSON.stringify(this.playerState) ) {
      this.playerState = newState;
      // Ablation study: only auto-push state when liveness is enabled
      const liveCoach = document.querySelector('live-coach');
      if (liveCoach && liveCoach.ablationSettings.liveness) {
        liveCoach.sendChatMessage({ to: "Coach", from: "Game", text: JSON.stringify(this.playerState) });
      }
    }
  }

  get_set_bits_from_packed_value({packed_value}) {
    const bits = [];
    for (let i = 0; i < 16; i++) {
      if (packed_value & (1 << i)) {
        bits.push(i);
      }
    }
    return bits;
  }

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
        <div id="fullscreen-caption-layer" aria-live="polite" aria-atomic="false"></div>
      </div>
    `;
  }
}
customElements.define('snes-emulator', SnesEmulator);
