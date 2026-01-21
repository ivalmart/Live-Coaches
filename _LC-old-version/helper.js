import { marked } from "https://esm.run/marked";

/* 
  Index of exported functions:
  
  displayMessage()
  getApiKey()
  getGameFromSearchParams()
  initEmulatorPage()
  initPlayerState()
*/

/* ----- Gemini Functions ----- */
// GEMINI API: Retrieves API key from local storage on browser, otherwise prompt user to input a valid Google AI Studio API Key
export function getApiKey() {
  let apiKey = localStorage.getItem("GEMINI_API_KEY");
  if (!apiKey) {
    let txt_apiKey = fetch("../api_key.txt");

    if(!txt_apiKey) {
      apiKey = prompt("Please enter your Gemini API key:");
    } else {
      apiKey = txt_apiKey.text();
    }

    if (apiKey) {
      localStorage.setItem("GEMINI_API_KEY", apiKey);
    }
  }
  return apiKey;
}

export function displayMessage(sender, message, chatDisplay, history) {
  if(!message) {
    return;
  }
  // Determine display label, class and emoji
  let className = '';
  let emoji = '';

  if (sender === 'Player') {
    className = 'Player-name';
    emoji = '';
  } else if (sender === 'Coach' || sender === 'Expert' || sender === 'Assistant') {
    className = 'Coach-name';
    emoji = '';
  } else if (sender === "FunctionCallResults") {
  // } else if (sender === 'FunctionCall' || sender === 'FunctionResults') {
    className = 'FunctionCall';
    sender = '🔧';
  }


  const messageElement = document.createElement("div");
  // Build the header markup. Only include emoji span if emoji is set.
  const header = emoji ? `<strong class="${className}"><span class="chat-emoji">${emoji}</span></strong>` : `<strong class="${className}">${sender}:</strong>`;
  // If emoji-only header (function), keep just the emoji; otherwise show label followed by ':'
  
  // Check if message contains HTML (from FunctionCall with collapsible element)
  const isHTML = sender === '🔧' && message.includes('<details>');
  const parsedMessage = isHTML ? message : marked.parse(message);
  
  messageElement.innerHTML = `${header}${parsedMessage}`;
  chatDisplay.appendChild(messageElement);
  chatDisplay.scrollTop = chatDisplay.scrollHeight;
  
  if(document.getElementById("speak-response").checked) {
    if (sender == "Coach") {
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.rate = 1.5;
      speechSynthesis.speak(utterance);
    }
  }

  history.push({ from: sender, text: message });
}


/* ----- Helper Code for Retrieval----- */
// WEBPAGE: Window Display for reading and setting current sub-page of SNES game
export function getGameFromSearchParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const gameParam = urlParams.get("Game");
  return gameParam ? decodeURIComponent(gameParam) : null;
}

// CONTROLLER HANDLER: Finds index of a controller input, refer to input_buttons for SNES controller key layout
function findInputIndex(key) {
  return input_buttons.findIndex((button) => button.key === key);
}

// EXPORT HANDLER: Downloads the current game state onto local files
export function downloadGameState(emulator) {
  let buffer = emulator.retro.serialize();
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${getGameFromSearchParams()}.state`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

/* ----- Helper Code for Initialization ----- */
// EMULATOR: Receives emulator object and initializes the player page for player controls, emulator page
export function initEmulatorPage(emulator) {
  // CONTROLLER HANDLER: Registers keyboard Inputs through the Game Window. Connects keyboard inputs into emulator controls
  emulator.canvas.addEventListener("keydown", (e) => {
    // Toggle fullscreen
    if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) {
            emulator.canvas.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
        e.preventDefault();
        return;
    }
    
    const index = findInputIndex(e.key);
    const keyState = `0,1,0,${index}`;
    // Checks to see if the key pressed down exists inside the keyboard inputs
    if (index != -1) {
      emulator.input_state[keyState] = 1;
    }
  });
  // CONTROLLER HANDLER: Resets registered button inputs
  emulator.canvas.addEventListener("keyup", (e) => {
    const index = findInputIndex(e.key);
    const keyState = `0,1,0,${index}`;
    // Checks to see if the key released exists inside the keyboard inputs
    if (index != -1) {
      emulator.input_state[keyState] = 0;
    }
  });

  // TEMP MAP HANDLER: Creates toggle button to show/hide Super Metroid Ross Map
  const toggleMap = document.getElementById("toggleMap");
  const mapDiv = document.getElementById("map");
  toggleMap.addEventListener("click", () => {
    const isHidden = mapDiv.style.display === "none";
    mapDiv.style.display = isHidden ? "block" : "none";
    toggleButton.textContent = isHidden ? "Hide Map" : "Show Map";
  });
}

// PLAYER: Initializes the player state object depending on the current game being played
export function initPlayerState(game) {
  if(game == "SuperMetroid") {
    return {
      energy: 0,
      missiles: 0,
      room: "foo",
      area: "bar",
      inventory: 0,
      closestNode: null
    };
    // return JSON.parse(`{"energy": 0, "missles": 0, "room": "foo", "area": "bar"}`);

  } else if(game == "EarthBound") {
    return JSON.parse(`{"hp": 0, "sp": 0, "town": "Onett"}`);
  }
  return null;
}

// ------- Keyboard-to-Game Controller Input Handler -------
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

// https://wiki.metroidconstruction.com/doku.php?id=sm:expert_guides:learning_asm
// Say bit 3 is reserved for screw attack, bit 2 is reserved for Morph Ball, bit 1 is reserved for Spring Ball, and bit 0 is reserved for Varia.
// Then, when you have Morph ball equipped, the value would be 0100 ($04). If you have Morph Ball AND Varia, it would be 0101 ($05).
// Section 14 of this link: https://metroidconstruction.com/SMMM/
export const item_flags = [
  { key: "Varia", value: 0x0001 }, // Varia Suit 
  { key: "Spring Ball", value: 0x0002 }, // Gravity Suit 
  { key: "Morph Ball", value: 0x0004 }, // Morph Ball 
  { key: "Screw Attack", value: 0x0008 }, // Screw Attack 
  // $0010 = None
  { key: "Gravity", value: 0x0020 }, // Gravity 0x0020
  // $0040 = None
  // $0080 = None
  { key: "Hi-Jump", value: 0x0100 }, // Hi-Jump Boots 
  { key: "Space Jump", value: 0x0200 }, // Space Jump
  // $0400 = None
  // $0800 = None
  { key: "Bomb", value: 0x1000 }, // Bombs
  { key: "Speed Booster", value: 0x2000 }, // Speed Booster
  { key: "Grapple Beam", value: 0x4000 }, // Grapple Beam
  { key: "X-Ray Scope", value: 0x8000 }, // X-Ray Scope
]


