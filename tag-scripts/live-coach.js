import { GoogleGenAI } from "https://esm.run/@google/genai";
import { marked } from "https://esm.run/marked";
import FUNCTION_DECLARATIONS from "../assets/function-declarations.json" with { "type": "json" }

// API Key Retrieval
async function getApiKey() {
  let apiKey = localStorage.getItem("GEMINI_API_KEY");
  
  if (!apiKey) {
    let txt_apiKey = await fetch("../api_key.txt");

    if (!txt_apiKey) {
      apiKey = prompt("Please enter your Gemini API key:");
    } else {
      apiKey = await txt_apiKey.text();
    }

    if (apiKey) {
      localStorage.setItem("GEMINI_API_KEY", apiKey);
    }
  }
  return apiKey;
}

class LiveCoach extends HTMLElement {
  static get observedAttributes() {
    return ['game-name'];
  }

  constructor() {
    super();
    // Chat variables
    this._ai = null;
    this._chat = null;
    this._instructions = "";
    this.history = [];

    // Specific game variables
    this.gameName = "";
    this.gamePrompt = "";
    this.geminiInit = false;

    this.ablationSettings = { liveness: false, coachness: false };
    this.ablationFunctions = [];

    // TTS settings
    this.ttsEnabled = localStorage.getItem("LIVE_COACH_TTS_ENABLED") === "true";
    this.ttsVoiceName = localStorage.getItem("LIVE_COACH_TTS_VOICE") || "";
    this.ttsHasPrimed = false;
  }

  getCoachSpeechText(rawMessage) {
    if (!rawMessage) {
      return "";
    }

    const html = marked.parse(rawMessage);
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;
    return tempDiv.textContent ? tempDiv.textContent.trim() : "";
  }

  tryPrimeSpeechSynthesis() {
    if (this.ttsHasPrimed || !window.speechSynthesis) {
      return;
    }
    this.ttsHasPrimed = true;
    try {
      window.speechSynthesis.resume();
    } catch (_error) {
      // Ignore browsers that do not expose resumable speech state.
    }
  }

  speakCoachMessage(rawMessage) {
    if (!this.ttsEnabled || !window.speechSynthesis) {
      return;
    }

    const text = this.getCoachSpeechText(rawMessage);
    if (!text) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 1.0;

    if (this.ttsVoiceName) {
      const voices = window.speechSynthesis.getVoices();
      const selectedVoice = voices.find((voice) => voice.name === this.ttsVoiceName);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }
    }

    // Keep coaching responsive: latest response interrupts stale speech.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  toggleTTS(button) {
    if (!button) {
      return;
    }
    button.textContent = this.ttsEnabled ? "TTS: ON" : "TTS: OFF";
    button.setAttribute("aria-pressed", this.ttsEnabled ? "true" : "false");
  }

  // called each time component is added onto document
  async connectedCallback() {
    this.gameName = this.getAttribute('game-name');
    await this.initAblationSettings();
    this.initLiveCoach();
  }

  async initAblationSettings() {
    const urlParams = new URLSearchParams(window.location.search);
    const CURRENT_ENVIRONMENT = urlParams.get('Env');
    switch (CURRENT_ENVIRONMENT) {
      case "Live-Coach":
        this.ablationSettings = { liveness: true, coachness: true };
        this._instructions = await fetch('../assets/prompts/Live_Coach.md').then(content => content.text());
        break;
      case "Liveness-Only":
        this.ablationSettings = { liveness: true, coachness: false };
        this._instructions = await fetch('../assets/prompts/Liveness_Only.md').then(content => content.text());
        break;
      case "Coachness-Only":
        this.ablationSettings = { liveness: false, coachness: true };
        this._instructions = await fetch('../assets/prompts/Coachness_Only.md').then(content => content.text());
        break;
      default:
        this.ablationSettings = { liveness: false, coachness: false };
        this._instructions = ""; // no prompt given (environment doesn't exist)
    }

    // Filter function declarations based on ablation settings
    this.ablationFunctions = FUNCTION_DECLARATIONS.filter(fd => {
      const acceptedFunctions = fd.included_ablation || [];

      if (this.ablationSettings.liveness && acceptedFunctions.includes("liveness")) {
        return true;
      }
      if (this.ablationSettings.coachness && acceptedFunctions.includes("coachness")) {
        return true;
      }
      return false;

    }).map(fd => {
      // removes the parameter that separates by environments since Gemini dislikes unknown parameters.
      const { included_ablation, ...cleaned } = fd;
      return cleaned;
    });
  }

  async initLiveCoach() {
    if (this.geminiInit) {
      return;
    }

    this.render();

    const environmentConfig = {
      systemInstruction: this._instructions,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      tools: [{ functionDeclarations: this.ablationFunctions }]
    };

    // Chat Creation
    const API_KEY = await getApiKey();
    this._ai = new GoogleGenAI({ apiKey: API_KEY });
    try {
      this._chat = await this._ai.chats.create({
        model: "gemini-3-flash-preview",
        config: environmentConfig,
      });
      this.geminiInit = true;

    } catch (error) {
      console.warn(error);
    }

    this.functionCallTools = {
      get_player_state() {
        const state = document.querySelector('snes-emulator').retrievePlayerState();
        return JSON.stringify(state);
      },
      save_to_slot({slot_index}) {
        try {
          const snes = document.querySelector('snes-emulator');
          if (!snes) {
            return "Error: <snes-emulator> element not found.";
          }
          if (!snes.emulator || !snes.emulator.retro) {
            return "Error: Emulator not initialized.";
          }
          snes.SAVE_SLOTS[slot_index] = snes.emulator.retro.serialize().slice();
          return "Saved to slot " + slot_index + "successfully!";
        } catch (error) {
          return "Error: " + (error && error.message ? error.message : error);
        }
      },
      load_from_slot({slot_index}) {
        try {
          const snes = document.querySelector('snes-emulator');
          if (!snes) {
            return "Error: <snes-emulator> element not found.";
          }
          if (!snes.emulator || !snes.emulator.retro) {
            return "Error: Emulator not initialized.";
          }
          const slotData = snes.SAVE_SLOTS[slot_index];
          if (!slotData || !(slotData instanceof Uint8Array)) {
            return `Error: Save slot ${slot_index} is empty or invalid.`;
          }
          snes.emulator.retro.unserialize(slotData);
          return "Loaded from slot " + slot_index + " successfully!";
        } catch (error) {
          return "Error: " + (error && error.message ? error.message : error);
        }
      },
      get_set_bits_from_packed_value({packed_value}) {
        // RELIANT ON SNES EMULATOR ELEMENT
        return document.querySelector('snes-emulator').get_set_bits_from_packed_value({packed_value});
      },
      async get_route_to_goal({nodeName, itemList, goalNode}) {
        const requestBody = { nodeName, itemList };
        if (goalNode) requestBody.goalNode = goalNode;
        let response = await fetch("https://sm-route-server-435712896720.us-west1.run.app/full_route", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
        });
        const data = await response.json();
        // Trim the verbose remaining_path to just a step count
        if (data.path && data.path.remaining_path) {
          const stepCount = data.path.remaining_path.length;
          data.path.remaining_path = `(${stepCount} more steps in the remaining path)`;
        }
        return data;
      },
      async get_node_info({nodeName}) {
        let response = await fetch("https://sm-route-server-435712896720.us-west1.run.app/node/" + nodeName);
        return await response.json();
      },
      direction_to_goal({goalCoords}) {
        // x axis <- towards 0, y axis ^ towards 0
        const playerObj = document.querySelector('sm-map').player;
        const playerCoords = { x: playerObj.x, y: playerObj.y };
        const directionVector = {
          x: goalCoords.x - playerCoords.x,
          y: goalCoords.y - playerCoords.y
        };

        let coordinalDirection = [];
        if(directionVector.x > 0) {
          coordinalDirection.push("right");
        } else if (directionVector.x < 0) {
          coordinalDirection.push("left");
        }

        if(directionVector.y > 0) {
          coordinalDirection.push("down");
        } else if (directionVector.y < 0) {
          coordinalDirection.push("up");
        }

        return coordinalDirection;
      },
      set_whiteboard_content({msg}) {
        try {
          const whiteboard = document.querySelector('coach-whiteboard');
          if (!whiteboard) return "Error: no <coach-whiteboard> element found on page.";
          whiteboard.setContent(msg);
          return "Done.";
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : e);
        }
      }
    };
  }

  // Sending Chat Message Functionality
  async sendChatMessage(message) {
    if (!this._chat) {
      console.warn("Tried to send message before chat was initialized:", message);
      return; // Chat not initialized yet
    }
    if (message) {
      if (message.from == "Player" || message.from == "Coach") {
        this.displayMessage(message.from, message.text, this.querySelector("#message_display"));
      }

      try {
        return;
        let response = await this._chat.sendMessage({
          message: `from=${message.from.toLowerCase()}\n` + message.text,
        });

        if(!response.functionCalls) {
          this.displayMessage("Coach", response.text, this.querySelector("#message_display"));
        } else {
          while(response.functionCalls) {
            const functionResponseParts = [];
            for (let call of response.functionCalls) {
              if (this.functionCallTools[call.name]) {
                let result = undefined;
                try {
                  result = await this.functionCallTools[call.name](call.args);
                } catch (error) {
                  console.warn("Error executing function call:", call.name, error);
                  result = "Error: " + error.message; // Return error message if function fails
                }

                // Creating collapsible element only for function call results (qol)
                let collapsibleResults = document.createElement("details");
                let fc_Title = document.createElement("summary");
                let contents = document.createElement("pre");
                collapsibleResults.className = "function-call-details";
                fc_Title.className = "function-call-summary";
                contents.className = "function-call-content";
                fc_Title.textContent = call.name;
                contents.textContent = "Arguments: " + JSON.stringify(call.args) + "\n\nResults: " + JSON.stringify(result);
                collapsibleResults.appendChild(fc_Title);
                collapsibleResults.appendChild(contents);

                let messageContainer = document.createElement("div");
                messageContainer.appendChild(collapsibleResults);
                this.displayMessage("FunctionCallResults", messageContainer.innerHTML, this.querySelector("#message_display"));

                functionResponseParts.push({
                  functionResponse: {
                    name: call.name,
                    response: { text: result}
                  },
                });
              }
            }

            if (functionResponseParts) {
              response = await this._chat.sendMessage({
                message: JSON.stringify(functionResponseParts),
              });

              this.displayMessage("Coach", response.text, this.querySelector("#message_display"));
            }
          }
        }

      } catch (error) {
        console.warn("Error sending message:", error);
        this.displayMessage("ErrorSystem", "Sorry, there was an error processing your message.", this.querySelector("#message_display"));
      }
    }
  }

  // Displaying Chat Message Funcitonality 
  displayMessage(sender, message, chatElement) {
    if (message) {
      const originalSender = sender;
      // Determine display label, class and emoji
      let className = '';
      let emoji = '';
      let isFunctionCallMessage = false;

      if (sender === 'Player') {
        className = 'Player-name';
        emoji = '';
      } else if (sender === 'Coach') {
        className = 'Coach-name';
        emoji = '';
      } else if (sender === "FunctionCallResults") {
        className = 'FunctionCall';
        sender = '🔧';
        isFunctionCallMessage = true;
      }

      const messageElement = document.createElement("div");
      messageElement.className = "chat-message";
      if (isFunctionCallMessage) {
        messageElement.classList.add("function-call-message");
      }
      // Build the header markup. Only include emoji span if emoji is set.
      const header = emoji ? `<strong class="${className}"><span class="chat-emoji">${emoji}</span></strong>` : `<strong class="${className}">${sender}:</strong>`;

      // Check if message contains HTML (from FunctionCall with collapsible element)
      const isHTML = sender === '🔧' && message.includes('<details>');
      const parsedMessage = isHTML ? message : marked.parse(message);

      messageElement.innerHTML = `${header}${parsedMessage}`;
      chatElement.appendChild(messageElement);
      chatElement.scrollTop = chatElement.scrollHeight;

      this.history.push({ from: sender, text: message });

      if (originalSender === 'Coach') {
        this.speakCoachMessage(message);
      }
    }
  }

  downloadChatTranscript() {
    const filename = "transcript.json";
    const transcriptContent = JSON.stringify(this.history);
    let element = document.createElement("a");
    element.setAttribute(
      "href",
      "data:text/plain;charset=utf-8," +
        encodeURIComponent(transcriptContent)
    );
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }

  // Inner HTML for individual web component
  render() {
    this.innerHTML = `
      <link rel="stylesheet" href="../style.css"/>
      <div id="message_display"></div>
      <div class="chat-input-row">
        <div class="chat-input-wrap" style="position:relative; display:inline-block; width:100%;">
          <input
            type="text"
            id="user-input"
            placeholder="Type your message..."
            style="padding-right:28px;"
          />
          <span id="mic-icon" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); font-size:16px; display:none; pointer-events:none;">🎤</span>
        </div>
        <button id="tts-toggle" type="button" class="tts-btn" aria-pressed="false">TTS: OFF</button>
      </div>
      <br>
    `;

    const playerInput = this.querySelector("#user-input");
    const micIcon = this.querySelector("#mic-icon");
    const ttsToggleBtn = this.querySelector("#tts-toggle");

    // Text-to-Speech Toggle Functionality
    this.toggleTTS(ttsToggleBtn);

    const applyTtsToggle = () => {
      this.ttsEnabled = !this.ttsEnabled;
      localStorage.setItem("LIVE_COACH_TTS_ENABLED", this.ttsEnabled ? "true" : "false");
      this.toggleTTS(ttsToggleBtn);

      if (!this.ttsEnabled && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      } else {
        this.tryPrimeSpeechSynthesis();
      }
    };

    ttsToggleBtn?.addEventListener("click", () => {
      applyTtsToggle();
    });

    if (window.speechSynthesis) {
      const voiceInitializer = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) {
          return;
        }

        if (!this.ttsVoiceName) {
          const preferredVoice = voices.find((voice) => /en-US/i.test(voice.lang)) || voices[0];
          if (preferredVoice) {
            this.ttsVoiceName = preferredVoice.name;
            localStorage.setItem("LIVE_COACH_TTS_VOICE", this.ttsVoiceName);
          }
        }
      };

      voiceInitializer();
      window.speechSynthesis.addEventListener("voiceschanged", voiceInitializer);
      this._cleanupTtsVoices = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", voiceInitializer);
      };

      const primeTtsHandler = () => {
        this.tryPrimeSpeechSynthesis();
        window.removeEventListener("pointerdown", primeTtsHandler);
      };
      window.addEventListener("pointerdown", primeTtsHandler);
      this._cleanupTtsPrime = () => {
        window.removeEventListener("pointerdown", primeTtsHandler);
      };
    }

    // Speech Recognition setup
    let recognition = null;
    let isListening = false;
    const micGamepadButtonIndices = [6, 7]; // Standard mapping: left/right triggers (ZL/ZR)
    const ttsGamepadButtonIndices = [16, 17]; // Commonly guide/home or touchpad/meta buttons
    let keyboardMicHeld = false;
    let gamepadMicHeld = false;
    let gamepadTtsToggleHeld = false;
    let gamepadPollId = null;

    const startMicHold = () => {
      if (!recognition || isListening) {
        return;
      }
      try {
        recognition.start();
        isListening = true;
        micIcon.style.display = 'inline';
      } catch (err) {
        // Ignore repeated starts while recognition is already active.
      }
    };

    const stopMicHold = () => {
      if (!recognition) {
        return;
      }
      if (!isListening) {
        return;
      }
      try {
        recognition.stop();
      } catch (err) {
        // Ignore stop race conditions while recognition is ending.
      }
      isListening = false;
      micIcon.style.display = 'none';
    };

    // For controlling microphone holding functionality (general controls)
    const syncMicHoldState = () => {
      const shouldHold = keyboardMicHeld || gamepadMicHeld;
      if (shouldHold) {
        startMicHold();
      } else {
        stopMicHold();
      }
    };

    const pollGamepadControls = () => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gamepad = Array.from(gamepads).find((gp) => gp && gp.connected);

      const micPressed = !!(
        gamepad &&
        gamepad.buttons &&
        micGamepadButtonIndices.some((buttonIndex) => gamepad.buttons[buttonIndex] && gamepad.buttons[buttonIndex].pressed)
      );

      const ttsTogglePressed = !!(
        gamepad &&
        gamepad.buttons &&
        ttsGamepadButtonIndices.some((buttonIndex) => gamepad.buttons[buttonIndex] && gamepad.buttons[buttonIndex].pressed)
      );

      if (micPressed && !gamepadMicHeld) {
        gamepadMicHeld = true;
        syncMicHoldState();
      } else if (!micPressed && gamepadMicHeld) {
        gamepadMicHeld = false;
        syncMicHoldState();
      }

      // Edge-detect so TTS toggles once per press, not every animation frame.
      if (ttsTogglePressed && !gamepadTtsToggleHeld) {
        gamepadTtsToggleHeld = true;
        applyTtsToggle();
      } else if (!ttsTogglePressed && gamepadTtsToggleHeld) {
        gamepadTtsToggleHeld = false;
      }

      gamepadPollId = requestAnimationFrame(pollGamepadControls);
    };

    gamepadPollId = requestAnimationFrame(pollGamepadControls);

    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        playerInput.value = event.results[0][0].transcript;
        // autosend message via mic
        this.sendChatMessage({ to: "Coach", from: "Player", text: playerInput.value });
        playerInput.value = '';
      };
      recognition.onerror = (event) => {
        isListening = false;
        micIcon.style.display = 'none';
      };
      recognition.onend = () => {
        isListening = false;
        micIcon.style.display = 'none';
      };
    }

    // Prevent spacebar from scrolling only when player is focused on game canvas
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement?.tagName === 'CANVAS') {
        e.preventDefault();
      }
    }, { passive: false });

    // Listen for spacebar hold/release, only when player is focused on game canvas
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && recognition && document.activeElement?.tagName === 'CANVAS') {
        keyboardMicHeld = true;
        syncMicHoldState();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && recognition) {
        keyboardMicHeld = false;
        syncMicHoldState();
      }
    });

    // Enter key for text input
    playerInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && playerInput.value.length > 0) {
        this.sendChatMessage({ to: "Coach", from: "Player", text: playerInput.value });
        playerInput.value = '';
      }
    });

    // Tear down gamepad polling if the component is removed.
    this._cleanupMicPolling = () => {
      if (gamepadPollId !== null) {
        cancelAnimationFrame(gamepadPollId);
      }
    };
  }

  disconnectedCallback() {
    if (this._cleanupMicPolling) {
      this._cleanupMicPolling();
    }

    if (this._cleanupTtsVoices) {
      this._cleanupTtsVoices();
    }

    if (this._cleanupTtsPrime) {
      this._cleanupTtsPrime();
    }
  }
}
customElements.define('live-coach', LiveCoach);