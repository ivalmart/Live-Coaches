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
    this.render();
  }
  connectedCallback() {
    this.romUrl = this.getAttribute('rom-url');
    this.romName = this.getAttribute('rom-name');

    this.stateUrl = this.getAttribute('state-url');
    this.init();
  }

  async init() {
    this.render();
    if (!this.romUrl) {
      return;
    }
    // Load ROM and currently passed save state
    this.romBytes = await this.fetchBinary(this.romUrl);
    try {
      this.stateBytes = this.stateUrl ? await this.fetchBinary(this.stateUrl) : null;
    } catch (e) {
      this.stateBytes = null;
    }

    // Initialize emulator w/ emulator functionality and controls
    this.setupEmulator();
    this.setupKeyboard();
    this.setupExportImport();
  }
  async fetchBinary(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error('Failed to fetch ' + url);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  setupEmulator() {
    // Initialize emulator using the snes.mjs function
    this.emulator = window.emulator = emulateSnesConsole(
      this.romBytes,
      this.stateBytes,
      this.querySelector('#emulator')
    );
  }

  setupKeyboard() {
    // Keyboard mapping of SNES controller
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

    const canvas = this.querySelector('canvas');
    // Pressing keyboard inputs
    canvas.addEventListener('keydown', e => {
      // Toggle fullscreen
      if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) {
          canvas.requestFullscreen();
        } else {
          document.exitFullscreen();
        }
        e.preventDefault();
        return;
      }

      const index = this.findGameInputIndex(e.key);
      const keyState = `0,1,0,${index}`;
      if (index !== -1) {
        this.emulator.input_state[keyState] = 1;
      }
    });
    // Releasing keyboard inputs
    canvas.addEventListener('keyup', e => {
      const index = this.findGameInputIndex(e.key);
      const keyState = `0,1,0,${index}`;
      if (index !== -1) {
        this.emulator.input_state[keyState] = 0;
      }
    });

    // Focus canvas for keyboard
    canvas.setAttribute('tabindex', 0);
    canvas.addEventListener('click', () => canvas.focus());
  }

  setupExportImport() {
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

  // Helper function to find index of controller input based on keyboard input
  findGameInputIndex(key) {
    return this.controllerInputs.findIndex((button) => button.key === key);
  }

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
