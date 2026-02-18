import { GoogleGenAI } from "https://esm.run/@google/genai";
import { marked } from "https://esm.run/marked";
import FUNCTION_DECLARATIONS from "../assets/function-declarations.json" with { "type": "json" }

// API Key Retrieval
async function getApiKey() {
  let apiKey = localStorage.getItem("GEMINI_API_KEY");
  apiKey = null;
  
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

    // Ablation study toggles
    this.livenessEnabled = true;
    this.coachnessEnabled = true;
  }

  // called each time component is added onto document
  connectedCallback() {
    this.gameName = this.getAttribute('game-name');
    this.initLiveCoach();
  }

  async initLiveCoach() {
    this.render();
    // update this to do all prompt construction based on the environment
    this._instructions = await fetch('../prompts/prompts.md').then(content => content.text());

    if (this.geminiInit) {
      return;
    }

    const API_KEY = await getApiKey();
    this._ai = new GoogleGenAI({ apiKey: API_KEY });

    try {
      this._chat = await this._ai.chats.create({
        model: "gemini-3-flash-preview",
        config: this._initChatConfig(),
      });
      this.geminiInit = true;

    } catch (error) {
      console.warn(error);
    }

    this.functionCallTools = {
      set_energy_level({level}) {
          const dv = document.querySelector('snes-emulator').callDataView();
          dv.setUint8(0x09C2, level);
          return dv.getUint8(0x09C2);
      },
      get_player_state() {
        const state = document.querySelector('snes-emulator').retrievePlayerState();
        return JSON.stringify(state);
      },
      // emulator.retro is not working at the moment as it is not initialized
      save_to_slot({slot_index}) {
        const emulator = document.querySelector('snes-emulator');
        emulator.SAVE_SLOTS[slot_index] = emulator.retro.serialize().slice();
        return "Done.";
      },
      load_from_slot({slot_index}) {
        try {
          const emulator = document.querySelector('snes-emulator');
          emulator.retro.unserialize(emulator.SAVE_SLOTS[slot_index]);
          return "Done.";
        } catch (error) {
          return "Error: " + error;
        }
      },
      evaluate_js_with_confirmation({code}) {
        if (confirm("Allow running this code?\n\n"+code)) {
          return "Code execution result: "+ eval(code);
        } else {
          return "The user disallowed this code execution.";
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

  // --------------- Ablation Study: Dynamic Environment Construction ---------------
  // Build Gemini chat config based on current ablation toggles
  // Function calling tools are only included when liveness is ON
  _initChatConfig() {
    const config = {
      systemInstruction: this._instructions,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    };
    const filteredFunctionDeclarations = FUNCTION_DECLARATIONS.filter(fd => {
      const acceptedFunctions = fd.included_ablation || [];
      if (this.livenessEnabled && acceptedFunctions.includes("liveness")) return true;
      if (this.coachnessEnabled && acceptedFunctions.includes("coachness")) return true;
      return false;
    });

    console.log("Filtered function declarations:", filteredFunctionDeclarations);

    if (filteredFunctionDeclarations.length > 0) {
      config.tools = [{ functionDeclarations: filteredFunctionDeclarations }];
    }
    return config;
  }

  // Switch ablation mode and re-initialize the chat session
  async setAblationMode(liveness, coachness) {
    this.livenessEnabled = liveness;
    this.coachnessEnabled = coachness;

    console.log(`Setting ablation mode - Liveness: ${liveness}, Coachness: ${coachness}`);

    // Log mode change
    const modeName = (liveness && coachness) ? "Live Coach (both)"
      : (liveness && !coachness) ? "Liveness Only"
      : (!liveness && coachness) ? "Coachness Only"
      : "Neither (baseline)";
    console.log(`Ablation mode changed to: ${modeName}`);

    // Re-create chat session with new system prompt and tools config
    if (this._ai) {
      try {
        this._chat = await this._ai.chats.create({
          model: "gemini-3-flash-preview",
          config: this._initChatConfig(),
        });

        // Clear chat display and history for clean ablation run
        const display = this.querySelector('#message_display');
        if (display) display.innerHTML = '';
        this.history = [];

        this.displayMessage("ErrorSystem", `Mode switched to: ${modeName}. Chat reset.`, this.querySelector('#message_display'));
      } catch (error) {
        console.warn("Error reinitializing chat for ablation mode:", error);
      }
    }
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
      // Determine display label, class and emoji
      let className = '';
      let emoji = '';

      if (sender === 'Player') {
        className = 'Player-name';
        emoji = '';
      } else if (sender === 'Coach') {
        className = 'Coach-name';
        emoji = '';
      } else if (sender === "FunctionCallResults") {
        className = 'FunctionCall';
        sender = '🔧';
      }

      const messageElement = document.createElement("div");
      // Build the header markup. Only include emoji span if emoji is set.
      const header = emoji ? `<strong class="${className}"><span class="chat-emoji">${emoji}</span></strong>` : `<strong class="${className}">${sender}:</strong>`;

      // Check if message contains HTML (from FunctionCall with collapsible element)
      const isHTML = sender === '🔧' && message.includes('<details>');
      const parsedMessage = isHTML ? message : marked.parse(message);

      messageElement.innerHTML = `${header}${parsedMessage}`;
      chatElement.appendChild(messageElement);
      chatElement.scrollTop = chatElement.scrollHeight;

      this.history.push({ from: sender, text: message });
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
      <input
        type="text"
        id="user-input"
        placeholder="Type your message..."
      /><br>
    `;

    const playerInput = this.querySelector("#user-input");
    playerInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && playerInput.value.length > 0) {
        this.sendChatMessage({ to: "Coach", from: "Player", text: playerInput.value });
        playerInput.value = '';
      }
    });
  }
}
customElements.define('live-coach', LiveCoach);