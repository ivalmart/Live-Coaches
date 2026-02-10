import { emulateSnesConsole } from "../SNES9x-framework/snes.mjs"; // Super Nintendo emulator import

// <snes-emulator> web component
class SnesEmulator extends HTMLElement {
  static get observedAttributes() {
    return ['rom-url', 'rom-name', 'state-url'];
  }
  constructor() {
    super();
    this.emulator = null;   // main emulator instance
    this.controllerInputs = null; // mapping of controller inputs

    this.romName = null;    // name of ROM for exporting purposes
    this.romUrl = null;     // ROM url from local assets folder
    this.romBytes = null;   // transformed bytes of loaded ROM

    this.stateUrl = null;   // save state url from local assets folder (optional)
    this.stateBytes = null; // transformed bytes of loaded save state

    this.playerState = {}; // current player state information (note: might curently only focus on Super Metroid)
    this.SAVE_SLOTS = new Array(10); // 10 save slots by default, will preload 4-9
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
    this.initKeyboard();
    this.initExportImport();
    await this.initSaveStates();
    this.playerState = this.retrievePlayerState();
  }

  async loadBinary(url) {
    let response = await fetch(url);
    return new Uint8Array(await response.arrayBuffer());
  }

  // Initialize emulator using snes.mjs functions
  initEmulator() {
    this.emulator = window.emulator = emulateSnesConsole(
      this.romBytes,
      this.stateBytes,
      this.querySelector('#emulator')
    );
  }

  // ----- Keyboard mapping of SNES controller -----
  initKeyboard() {
    this.controllerInputs = [
      { key: "l", value: "B" }, // B button, 0
      { key: "k", value: "Y" }, // Y button, 1
      { key: "Shift", value: "Select" }, // Select button, 2
      { key: "Enter", value: "Start" }, // Start button, 3
      { key: "w", value: "Up" }, // Up button, 4
      { key: "s", value: "Down" }, // Down button, 5
      { key: "a", value: "Left" }, // Left button, 6
      { key: "d", value: "Right" }, // Right button, 7
      { key: "p", value: "A" }, // A button, 8
      { key: "o", value: "X" }, // X button, 9
      { key: "q", value: "LeftTrigger" }, // Left bumper, 10
      { key: "e", value: "RightTrigger" }, // Right bumper, 11
    ];

    // Pressing keyboard events
    const canvas = this.querySelector('canvas');
    canvas.addEventListener('keydown', e => {
      if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) {
          canvas.requestFullscreen();
        } else {
          document.exitFullscreen();
        }
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
    return this.controllerInputs.findIndex((button) => button.key === key);
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
        missiles: dv.getUint8(0x09C4),
        inventory: this.get_set_bits_from_packed_value({ packed_value: dv.getUint16(0x09A4, true) }),
        closestNode: map_closestNode
      };
    }
  }
  updatePlayerState() {
    const newState = this.retrievePlayerState();
    if( JSON.stringify(newState) !== JSON.stringify(this.playerState) ) {
      this.playerState = newState;
      // Ablation study: only auto-push state when liveness is enabled
      const liveCoach = document.querySelector('live-coach');
      if (liveCoach && liveCoach.livenessEnabled) {
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
        <div id="emulator"></div>
        <div>
          <button id="export">Export State</button>
          <button id="import">Import State</button>
        </div>
      </div>
    `;
  }
}
customElements.define('snes-emulator', SnesEmulator);
