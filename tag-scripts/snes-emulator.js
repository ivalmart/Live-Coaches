// <snes-emulator> web component
class SnesEmulator extends HTMLElement {
    static get observedAttributes() {
        return ['rom-url', 'state-url', 'rom-name'];
    }
    constructor() {
        super();
        this.emulator = null;   // main emulator instance
        this.romUrl = null;     // ROM url from assets
        this.romBytes = null;   // transformed bytes of loaded ROM
        this.stateUrl = null;   // save state url from assets (optional)
        this.stateBytes = null; // transformed bytes of loaded save state
        this.romName = null;    // name of ROM for exporting purposes
        this.render();
    }
    connectedCallback() {
        this.romUrl = this.getAttribute('rom-url');
        this.stateUrl = this.getAttribute('state-url');
        this.romName = this.getAttribute('rom-name');
        this.init();
    }

    // unsure if this is needed? if attributes change such as RomURL, results in an emulator crash
    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'rom-url' || name === 'state-url') {
            this[name.replace('-', 'Url')] = newValue;
            if (name === 'rom-url' && newValue) {
                this.init();
            }
        }
    }
    
    async init() {
        this.render();
        if (!this.romUrl) {
            return;
        }
        // Import emulator dependencies directly
        const retro = await import('https://cdn.skypack.dev/pin/snes9x-next@v1.0.0-cli3XObByFqiqSouAHTv/mode=imports,min/optimized/snes9x-next.js');
        const thingpixel = await import('https://cdn.skypack.dev/pin/@thi.ng/pixel@v4.2.7-YzsdE4qjK7uUqur4AuyF/mode=imports,min/optimized/@thi.ng/pixel.js');
        // Load ROM and currently passed save state
        this.romBytes = await this.fetchBinary(this.romUrl);
        try {
            this.stateBytes = this.stateUrl ? await this.fetchBinary(this.stateUrl) : null;
        } catch (e) {
            this.stateBytes = null;
        }

        // let coachPrompt = await fetch('./prompts/coach-prompt.txt');
        // console.log(await coachPrompt.text());

        // Initialize emulator w/ emulator functionality and controls
        this.setupEmulator(retro, thingpixel);
        this.setupKeyboard();
        this.setupExportImport();
    }
    async fetchBinary(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to fetch ' + url);
        return new Uint8Array(await res.arrayBuffer());
    }
    setupEmulator(retro, thingpixel) {
        // Inline emulateSnesConsole logic
        const emulator = new EventTarget();
        emulator.retro = retro;
        const input_state = (emulator.input_state = {});

        const av_info = retro.get_system_av_info();
        
        const container = this.querySelector('#emu-container');
        // Remove any previous canvas
        container.innerHTML = '';
        const canvas = (emulator.canvas = document.createElement('canvas'));
        const width = av_info.geometry.base_width;
        const height = av_info.geometry.base_height;
        canvas.setAttribute('width', width);
        canvas.setAttribute('height', height);
        canvas.setAttribute('tabindex', 0);
        container.append(canvas);

        const context = canvas.getContext('2d');
        const imageData = context.createImageData(width, height);
        
        // Environment setup
        const environment_command_names = {};
        for (let [k, v] of Object.entries(retro)) {
            if (k.startsWith('ENVIRONMENT')) {
                environment_command_names[v] = k;
            }
        }
        
        retro.set_environment((cmd, data) => {
            //console.log('environment', environment_command_names[cmd], data);
            if (cmd == retro.ENVIRONMENT_GET_LOG_INTERFACE) {
            return function (level, msg) {
                // console.log("retro log", level, msg);
            };
            } else {
            return true;
            }
        });
        retro.set_input_poll(() => {
            //console.log('input_poll');
        });
        
        retro.set_input_state((port, device, input, id) => {
            //console.log('input_state', port, device, input, id);
            const key = [port, device, input, id].toString();
            if (input_state[key]) {
                return input_state[key];
            } else {
                return 0; // not pressed by default
            }
        });
        
        retro.set_video_refresh((data, width, height, pitch) => {
            //console.log('video_refresh', data, width, height, pitch);
            const buffer = new thingpixel.IntBuffer(
                pitch / 2,
                height,
                thingpixel.RGB565,
                data
            );
            buffer.getRegion(0, 0, width, height).toImageData(imageData);
            context.putImageData(imageData, 0, 0);
        });

        retro.set_audio_sample_batch((left, right, frames) => {
            //console.log('audio_sample_batch', left, right, frames);
            return frames;
        });
        
        retro.init();
        retro.load_game(this.romBytes);
        if (this.stateBytes) {
            retro.unserialize(this.stateBytes);
        }
        let running = true;
            
        function tick() {
            if (running) {
                try {
                    emulator.dispatchEvent(new Event("beforeRun"));
                    retro.run();
                    emulator.dispatchEvent(new Event("afterRun"));
                } catch (err) {
                    console.log("err", err);
                }
            }
        }
        setInterval(tick, 1000 / 60);
        this.emulator = emulator;
    }

    setupKeyboard() {
        const input_buttons = [
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
        const findInputIndex = key => input_buttons.findIndex(b => b.key === key);
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
            const idx = findInputIndex(e.key);
            const keyState = `0,1,0,${idx}`;
            if (idx !== -1) this.emulator.input_state[keyState] = 1;
        });
        // Releasing keyboard inputs
        canvas.addEventListener('keyup', e => {
            const idx = findInputIndex(e.key);
            const keyState = `0,1,0,${idx}`;
            if (idx !== -1) this.emulator.input_state[keyState] = 0;
        });

        // Focus canvas for keyboard
        canvas.setAttribute('tabindex', 0);
        canvas.addEventListener('click', () => canvas.focus());
    }

    setupExportImport() {
        // Export state
        this.querySelector('#export').onclick = () => {
            if (!this.emulator) return;
            const buffer = this.emulator.retro.serialize();
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${this.romName}.state`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        };
        // Import state
        this.querySelector('#import').onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.state,application/octet-stream';
            input.onchange = async e => {
                const file = e.target.files[0];
                if (!file) return;
                const arr = new Uint8Array(await file.arrayBuffer());
                try {
                    this.emulator.retro.unserialize(arr);
                } catch (err) {
                    alert('Failed to load state: ' + err);
                }
            };
            input.click();
        };
    }

    // retrieves current state as a Uint8Array, or null if not available
    getSaveState() {
        if (!this.emulator || !this.emulator.retro) {
            return null;
        }
        try {
            return this.emulator.retro.serialize().slice();
        } catch (e) {
            return null;
        }
    }
    // loads a previously saved state from a Uint8Array
    loadSaveState(state) {
        if (!this.emulator || !this.emulator.retro || !state) {
            return;
        }
        try {
            this.emulator.retro.unserialize(state);
        } catch (e) {
            alert('Failed to load state: ' + e);
        }
    }

    callWithMemory(fn) {
        if (!this.emulator || !this.emulator.retro) {
            return;
        }
        try {
            const buffer = this.emulator.retro.get_memory_data(2).buffer;
            const dv = new DataView(buffer);
            return fn(dv);
        } catch (e) {
            // Optionally handle error
        }
    }

    render() {
        this.innerHTML = `
        <link rel="stylesheet" href="../style.css" />
        <div class="emulator">
            <div id="emu-container">
            <canvas id="screen" width="256" height="224"></canvas>
            </div>
            <div>
            <button id="export">Export State</button>
            <button id="import">Import State</button>
            </div>
            <div style="margin-top:0.5em; color:#aaa; font-size:0.9em;">
            ${!this.romUrl ? '<span class="missing">No ROM specified. Set rom-url attribute.</span>' : '(Click on game screen to sync keyboard to play!)'}
            </div>
        </div>
        `;
    }
}
customElements.define('snes-emulator', SnesEmulator);
