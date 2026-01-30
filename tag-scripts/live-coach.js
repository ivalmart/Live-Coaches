import { GoogleGenAI } from "https://esm.run/@google/genai";
import { marked } from "https://esm.run/marked";

// API Key Retrieval
async function getApiKey() {
  let apiKey = localStorage.getItem("GEMINI_API_KEY");
  if (!apiKey) {
    let txt_apiKey = await fetch("../api_key.txt");

    if(!txt_apiKey) {
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
    this._ai = null;
    this._chat = null;
    this._instructions = "";
    this.history = [];

    this.gameName = "";
    this.gamePrompt = "";
    // this._gameState = null;
    this.geminiInit = false;
    // this.functionCalls = null;
    this.render();
  }

  connectedCallback() {
    this.gameName = this.getAttribute('game-name');
    this.initLiveCoach();
  }

  // First instance of creating the Live Coach
  async initLiveCoach() {
    this.render();
    await this.initCoachGamePrompt();
    if (this.geminiInit) {
      return;
    }

    const API_KEY = await getApiKey();
    this._ai = new GoogleGenAI({ apiKey: API_KEY });

    try {
      this._chat = this._ai.chats.create({
        model: "gemini-3-flash-preview",
        config: {
          systemInstruction: this._instructions,
            thinkingConfig: {
                thinkingLevel: "MINIMAL",
            }
        }
      });
      this.geminiInit = true;
    } catch (error) {
      console.warn(error);
    }

    // this.functionCalls = {
    //     set_energy_level({level}) {
    //         const dv = document.querySelector('snes-emulator').callDataView();
    //         dv.setUint8(0x09C2, level);
    //         return dv.getUint8(0x09C2);
    //     },
    //     get_player_state() {
    //       const state = getCurrentPlayerState(dv);
    //       return JSON.stringify(state);
    //     },
    //     save_to_slot({slot_index}) {
    //       saveSlots[slot_index] = emulator.retro.serialize().slice();
    //       return "Done.";
    //     },
    //     load_from_slot({slot_index}) {
    //       try {
    //         emulator.retro.unserialize(saveSlots[slot_index]);
    //         return "Done.";
    //       } catch (error) {
    //         return "Error: " + error;
    //       }
    //     },
    //     evaluate_js_with_confirmation({code}) {
    //       if (confirm("Allow running this code?\n\n"+code)) {
    //         return "Code execution result: "+ eval(code);
    //       } else {
    //         return "The user disallowed this code execution.";
    //       }
    //     },
    //     get_set_bits_from_packed_value({packed_value}) {
    //       // Function to get set bits from a packed value
    //       const bits = [];
    //       for (let i = 0; i < 16; i++) {
    //         if (packed_value & (1 << i)) {
    //           bits.push(i);
    //         }
    //       }
    //       return bits;
    //     },
    //     async get_next_step_on_plan_to_beat_game({nodeName, itemList}) {
    //       // return "Head to the right"; // placeholder value
    //       let response = await fetch("http://localhost:8008/next_node", {
    //         method: "POST",
    //         headers: {
    //         "Content-Type": "application/json"
    //         },
    //         body: JSON.stringify({ nodeName, itemList })
    //       });
    //       return await response.json();
    //     },
    //     async get_node_info({nodeName}) {
    //       // example: http://localhost:8008/node/Parlor_R1
    //       let response = await fetch("http://localhost:8008/node/" + nodeName);
    //       return await response.json();
    //     }
    //   //   ,
    //   //   set_whiteboard_content({msg}) {
    //   //     try {
    //   //       setWhiteboardContent(msg);
    //   //       return "Done.";
    //   //     } catch (e) {
    //   //       return "Error: " + (e && e.message ? e.message : e);
    //   //     }
    //   //   }
    // };
    const emulator = document.querySelector('snes-emulator');
    emulator.exportSaveState();
  }

  // Prompt Retrieval Concatenation
  async initCoachGamePrompt() {
    let coachPrompt = await fetch('../prompts/coach-prompt.md');
    this._instructions = this._instructions.concat(await coachPrompt.text());
    let gamePrompt = await fetch(`../prompts/${this.gameName}.md`);
    this._instructions = this._instructions.concat("\n\n").concat(await gamePrompt.text());
  }

  // Sending Chat Message Functionality
  async sendChatMessage(message) {
    if (message) {
      if (message.from == "Player" || message.from == "Coach") {
        this.displayMessage(message.from, message.text, this.querySelector("#message_display"));
      }

      try {
        return;
        let response = await this._chat.sendMessage({
          message: `from=${message.from.toLowerCase()}\n` + message.text,
        });

        this.displayMessage("Coach", response.text, this.querySelector("#message_display"));
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
      // } else if (sender === "FunctionCallResults") {
      //   className = 'FunctionCall';
      //   sender = '🔧';
      }

      const messageElement = document.createElement("div");
      // Build the header markup. Only include emoji span if emoji is set.
      const header = emoji ? `<strong class="${className}"><span class="chat-emoji">${emoji}</span></strong>` : `<strong class="${className}">${sender}:</strong>`;

      // Check if message contains HTML (from FunctionCall with collapsible element)
      // const isHTML = sender === '🔧' && message.includes('<details>');
      const parsedMessage = marked.parse(message);

      messageElement.innerHTML = `${header}${parsedMessage}`;
      chatElement.appendChild(messageElement);
      chatElement.scrollTop = chatElement.scrollHeight;

      this.history.push({ from: sender, text: message });
    }
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