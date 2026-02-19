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

    this.ablationSettings = { liveness: false, coachness: false };
    this.ablationFunctions = [];
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
    console.log("Current Environment:", CURRENT_ENVIRONMENT);
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

    console.log("Filtered function declarations (for Gemini):", this.ablationFunctions);
  }

  async initLiveCoach() {
    if (this.geminiInit) {
      return;
    }

    this.render();

    console.log("this._instructions:", this._instructions);
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

    console.log("Environment Config for Gemini:", environmentConfig);

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
        // return;
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