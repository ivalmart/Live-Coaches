import { GoogleGenAI } from "https://esm.run/@google/genai";

function getApiKey() {
  let apiKey = localStorage.getItem("GEMINI_API_KEY");
  if (!apiKey) {
    apiKey = prompt("Please enter your Gemini API key:");
    if (apiKey) {
      localStorage.setItem("GEMINI_API_KEY", apiKey);
    }
  }
  return apiKey;
}

class LiveCoach extends HTMLElement {
    static get observedAttributes() {
       return ['game-prompt'];
    }

    constructor() {
        super();
        this._ai = null;
        this._chat = null;
        this._instructions = "";
        this.history = [];

        this.gamePrompt = "";
        this._gameState = null;
        this.geminiInit = false;
        this.render();
    }

    async connectedCallback() {
        let gameSpecificPrompt = this.getAttribute('game-prompt');
        if(gameSpecificPrompt) {
            this.gamePrompt = await fetch(gameSpecificPrompt);
        } else {
            console.warn("No game prompt provided for Live Coach.");
        }
    }

    set gameState(val) {
        this._gameState = val;
    }

    async initLiveCoach() {
        if(this.geminiInit) return;
        const apiKey = getApiKey();
        this._ai = new GoogleGenAI({ apiKey: getApiKey()});

        let coachPrompt = await fetch('./prompts/coach-prompt.txt');
        this._instructions = this._instructions.concat(await coachPrompt.text());

        let tools = [];

        try {
            this._chat = this._ai.chats.create({
                model: "gemini-2.5-flash",
                config: {
                    systemInstructions: this._instructions
                }

            });
        } catch(error) {
            console.warn(error);
        }
    }

    render() {
        this.shadowRoot.innerHTML = `
        <div id="message_display></div>
        <input
            type="text"
            id="user-input"
            size="60"
            rows="5"
            placeholder="Type your message to the Live Coach..."
        /><br>
        `;
        this.shadowRoot.getElementById('message_display').addEventListener('keypress', (e) => {
            let textFieldVal = this.querySelector('#user-input').value;
            if (e.key === 'Enter' && textFieldVal.length > 0) {
                // this.sendMessage(textFieldVal);
                console.log(textFieldVal);
                this.querySelector('#user-input').value = '';
            }
        });
    }
}
customElements.define('live-coach', LiveCoach);