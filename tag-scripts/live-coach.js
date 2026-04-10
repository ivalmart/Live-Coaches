import { GoogleGenAI } from "https://esm.run/@google/genai";
import { marked } from "https://esm.run/marked";
import FUNCTION_DECLARATIONS from "../assets/function-declarations.json" with { "type": "json" }
import ALL_ROUTE_NODES from "../SNES9x-framework/all_nodes.json" with { "type": "json" }

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
    this.currentEnvironment = null;
    this.livenessEnvironments = new Set(["Live-Coach", "Liveness-Only"]);

    this.ablationSettings = { liveness: false, coachness: false };
    this.ablationFunctions = [];

    // TTS settings
    this.ttsEnabled = localStorage.getItem("LIVE_COACH_TTS_ENABLED") === "true";
    this.ttsVoiceName = localStorage.getItem("LIVE_COACH_TTS_VOICE") || "";
    this.ttsHasPrimed = false;
    this.coachCaptionKey = "coach-live-caption";
    this.activeCoachSpeechToken = 0;
    this.fullscreenCaptionsEnabled = localStorage.getItem("LIVE_COACH_FULLSCREEN_CAPTIONS_ENABLED") !== "false";
    this.isMicPriorityActive = false;
    this.pendingCoachSpeechMessage = null;

    // Function call visibility toggle
    this.functionCallsVisible = localStorage.getItem("LIVE_COACH_FUNCTION_CALLS_VISIBLE") !== "false";
    this.extraControlsVisible = localStorage.getItem("LIVE_COACH_EXTRA_CONTROLS_VISIBLE") !== "false";

    // Global activity indicator state (chat + fullscreen)
    this.pendingWorkCount = 0;
    this.systemThinkingText = "System is thinking...";

    // Planner node validation helpers
    this.routeNodeNames = Object.keys(ALL_ROUTE_NODES);
    this.routeNodeSet = new Set(this.routeNodeNames);
    this.routeNodeLowerMap = new Map(
      this.routeNodeNames.map((name) => [name.toLowerCase(), name])
    );
    this.routeNodeCompactMap = new Map(
      this.routeNodeNames.map((name) => [
        name.toLowerCase().replace(/[^a-z0-9]/g, ""),
        name,
      ])
    );
  }

  resolveDesignSpaceNodeName(rawNodeName) {
    if (typeof rawNodeName !== "string") {
      return null;
    }

    const trimmed = rawNodeName.trim();
    if (!trimmed) {
      return null;
    }

    if (this.routeNodeSet.has(trimmed)) {
      return trimmed;
    }

    const underscored = trimmed.replace(/\s+/g, "_");
    if (this.routeNodeSet.has(underscored)) {
      return underscored;
    }

    const lowerTrimmed = trimmed.toLowerCase();
    if (this.routeNodeLowerMap.has(lowerTrimmed)) {
      return this.routeNodeLowerMap.get(lowerTrimmed);
    }

    const lowerUnderscored = underscored.toLowerCase();
    if (this.routeNodeLowerMap.has(lowerUnderscored)) {
      return this.routeNodeLowerMap.get(lowerUnderscored);
    }

    const compact = lowerTrimmed.replace(/[^a-z0-9]/g, "");
    if (this.routeNodeCompactMap.has(compact)) {
      return this.routeNodeCompactMap.get(compact);
    }

    return null;
  }

  suggestDesignSpaceNodes(rawNodeName, limit = 5) {
    if (typeof rawNodeName !== "string") {
      return [];
    }

    const normalized = rawNodeName.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const normalizedWithUnderscores = normalized.replace(/\s+/g, "_");
    const compact = normalized.replace(/[^a-z0-9]/g, "");

    const scored = [];
    for (const nodeName of this.routeNodeNames) {
      const candidate = nodeName.toLowerCase();
      const candidateCompact = candidate.replace(/[^a-z0-9]/g, "");
      let score = 0;

      if (candidate.startsWith(normalizedWithUnderscores)) {
        score += 5;
      }
      if (candidate.includes(normalizedWithUnderscores)) {
        score += 3;
      }
      if (compact && candidateCompact.includes(compact)) {
        score += 2;
      }

      if (score > 0) {
        scored.push({ nodeName, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || a.nodeName.localeCompare(b.nodeName))
      .slice(0, limit)
      .map((entry) => entry.nodeName);
  }

  buildNodeValidationError(rawNodeName, fieldName) {
    const safeRawNodeName = typeof rawNodeName === "string" ? rawNodeName : String(rawNodeName);
    const suggestions = this.suggestDesignSpaceNodes(safeRawNodeName);
    const suggestionText = suggestions.length
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : "";

    return {
      success: false,
      message: `Invalid ${fieldName} '${safeRawNodeName}'. This node does not exist in the route planner design space.${suggestionText}`,
      invalidNode: safeRawNodeName,
      suggestions,
      knownNodeCount: this.routeNodeNames.length,
    };
  }

  buildFunctionResponsePayload(result) {
    let responseText;
    let parts = [];

    if (result && typeof result === "object") {
      if (Array.isArray(result.parts)) {
        parts = result.parts.filter((part) => part && typeof part === "object");
      }
      if (typeof result.responseText === "string") {
        responseText = result.responseText;
      }
    }

    if (responseText === undefined) {
      responseText = typeof result === "string" ? result : JSON.stringify(result);
    }

    return {
      response: { text: responseText },
      parts,
    };
  }

  getTranscriptTimestamp() {
    return new Date().toLocaleTimeString([], {
      hour12: true,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  buildTranscriptEntry(from, text) {
    return {
      from,
      text,
      timestamp: this.getTranscriptTimestamp(),
    };
  }

  summarizeFunctionResult(result) {
    if (!result || typeof result !== "object") {
      return result;
    }

    if (Array.isArray(result.parts)) {
      return {
        ...result,
        parts: result.parts.map((part) => {
          if (!part || !part.inlineData || typeof part.inlineData.data !== "string") {
            return part;
          }
          return {
            ...part,
            inlineData: {
              ...part.inlineData,
              data: `<base64 ${part.inlineData.data.length} chars>`,
            },
          };
        }),
      };
    }

    return result;
  }

  beginSystemWork(statusText = "System is thinking...") {
    this.pendingWorkCount += 1;
    this.systemThinkingText = statusText;
    this.updateSystemThinkingIndicator();
  }

  updateSystemWorkStatus(statusText) {
    if (!statusText) {
      return;
    }
    this.systemThinkingText = statusText;
    if (this.pendingWorkCount > 0) {
      this.updateSystemThinkingIndicator();
    }
  }

  endSystemWork() {
    this.pendingWorkCount = Math.max(0, this.pendingWorkCount - 1);
    if (this.pendingWorkCount === 0) {
      this.systemThinkingText = "System is thinking...";
    }
    this.updateSystemThinkingIndicator();
  }

  updateSystemThinkingIndicator() {
    const isActive = this.pendingWorkCount > 0;
    const indicator = this.querySelector("#system-thinking-indicator");
    if (indicator) {
      const textNode = indicator.querySelector(".thinking-text");
      if (textNode) {
        textNode.textContent = this.systemThinkingText;
      }
      indicator.style.display = isActive ? "flex" : "none";
      indicator.setAttribute("aria-hidden", isActive ? "false" : "true");
    }

    const snes = document.querySelector('snes-emulator');
    if (snes && typeof snes.setSystemActivityIndicator === 'function') {
      snes.setSystemActivityIndicator({
        visible: isActive,
        text: this.systemThinkingText,
      });
    }
  }

  setRecordingModeFeedback(isActive) {
    const snes = document.querySelector('snes-emulator');
    if (snes && typeof snes.setRecordingModeActive === 'function') {
      snes.setRecordingModeActive(!!isActive);
    }
  }

  createFunctionCallMessage(call) {
    const messageDisplay = this.querySelector("#message_display");
    if (!messageDisplay) {
      return null;
    }

    const messageElement = document.createElement("div");
    messageElement.className = "chat-message function-call-message";

    const details = document.createElement("details");
    details.className = "function-call-details function-call-pending";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "function-call-summary function-call-summary-pending";
    summary.textContent = `${call.name} (running...)`;

    const content = document.createElement("pre");
    content.className = "function-call-content";
    content.textContent = `Status: Running...\nArguments: ${JSON.stringify(call.args)}`;

    details.appendChild(summary);
    details.appendChild(content);
    messageElement.appendChild(details);
    messageDisplay.appendChild(messageElement);
    messageDisplay.scrollTop = messageDisplay.scrollHeight;

    if (!this.functionCallsVisible) {
      messageElement.style.display = "none";
    }

    return { messageElement, details, summary, content, callName: call.name, callArgs: call.args };
  }

  finalizeFunctionCallMessage(messageRefs, result, error) {
    if (!messageRefs) {
      return;
    }

    const { details, summary, content, callName, callArgs } = messageRefs;
    const argsText = JSON.stringify(callArgs);

    details.classList.remove("function-call-pending", "function-call-complete", "function-call-error");
    summary.classList.remove("function-call-summary-pending", "function-call-summary-complete", "function-call-summary-error");

    if (error) {
      details.classList.add("function-call-error");
      summary.classList.add("function-call-summary-error");
      summary.textContent = `${callName} (error)`;
      content.textContent = `Arguments: ${argsText}\n\nError: ${error}`;
      return;
    }

    details.classList.add("function-call-complete");
    summary.classList.add("function-call-summary-complete");
    summary.textContent = `${callName} (done)`;
    const summarizedResult = this.summarizeFunctionResult(result);
    content.textContent = `Arguments: ${argsText}\n\nResults: ${JSON.stringify(summarizedResult)}`;
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

    if (this.isMicPriorityActive) {
      this.pendingCoachSpeechMessage = rawMessage;
      return;
    }

    const text = this.getCoachSpeechText(rawMessage);
    if (!text) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const speechToken = ++this.activeCoachSpeechToken;
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
    utterance.onstart = () => {
      this.showFullscreenCaption('Coach', rawMessage, { holdUntilDismiss: true });
    };

    utterance.onend = () => {
      if (speechToken !== this.activeCoachSpeechToken) {
        return;
      }
      const snes = document.querySelector('snes-emulator');
      if (snes && typeof snes.dismissFullscreenCaption === 'function') {
        snes.dismissFullscreenCaption(this.coachCaptionKey, 1200);
      }
    };

    utterance.onerror = () => {
      if (speechToken !== this.activeCoachSpeechToken) {
        return;
      }
      const snes = document.querySelector('snes-emulator');
      if (snes && typeof snes.dismissFullscreenCaption === 'function') {
        snes.dismissFullscreenCaption(this.coachCaptionKey, 900);
      }
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  flushPendingCoachSpeech() {
    if (this.isMicPriorityActive || !this.pendingCoachSpeechMessage) {
      return;
    }

    const pendingMessage = this.pendingCoachSpeechMessage;
    this.pendingCoachSpeechMessage = null;
    this.speakCoachMessage(pendingMessage);
  }

  estimateSpeechDurationMs(text) {
    if (!text) {
      return 3000;
    }
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const wordsPerMinute = 170;
    const msPerWord = 60000 / wordsPerMinute;
    const estimatedSpeechMs = words * msPerWord;
    return Math.min(12000, Math.max(3000, Math.round(estimatedSpeechMs + 1200)));
  }

  showFullscreenCaption(sender, rawMessage, options = {}) {
    if (!rawMessage || (sender !== 'Player' && sender !== 'Coach')) {
      return;
    }

    const snes = document.querySelector('snes-emulator');
    if (!snes || typeof snes.showFullscreenCaption !== 'function') {
      return;
    }

    const text = sender === 'Coach' ? this.getCoachSpeechText(rawMessage) : String(rawMessage).trim();
    if (!text) {
      return;
    }

    const hasSpeechSynthesis = !!window.speechSynthesis;
    const shouldPinCoachCaption = sender === 'Coach' && this.ttsEnabled && hasSpeechSynthesis;

    snes.showFullscreenCaption({
      speaker: sender,
      text,
      captionKey: sender === 'Coach' ? this.coachCaptionKey : undefined,
      holdUntilDismiss: options.holdUntilDismiss || shouldPinCoachCaption,
      lingerMs: sender === 'Player' ? 3000 : this.estimateSpeechDurationMs(text)
    });
  }

  toggleTTS(button) {
    if (!button) {
      return;
    }
    button.textContent = this.ttsEnabled ? "TTS: ON" : "TTS: OFF";
    button.setAttribute("aria-pressed", this.ttsEnabled ? "true" : "false");
  }

  updateFunctionCallsToggle(button) {
    if (!button) {
      return;
    }
    button.textContent = this.functionCallsVisible ? "FC Show: ON" : "FC Show: OFF";
    button.setAttribute("aria-pressed", this.functionCallsVisible ? "true" : "false");
  }

  updateCaptionsToggle(button) {
    if (!button) {
      return;
    }
    button.textContent = this.fullscreenCaptionsEnabled ? "Captions: ON" : "Captions: OFF";
    button.setAttribute("aria-pressed", this.fullscreenCaptionsEnabled ? "true" : "false");
  }

  updateExtraControlsToggle(button, controlledButtons = []) {
    controlledButtons.forEach((controlledButton) => {
      if (controlledButton) {
        controlledButton.style.display = this.extraControlsVisible ? "" : "none";
      }
    });

    if (!button) {
      return;
    }

    button.textContent = this.extraControlsVisible ? "Admin: ON" : "Admin: OFF";
    button.setAttribute("aria-pressed", this.extraControlsVisible ? "true" : "false");
  }

  syncFullscreenCaptionsState() {
    const snes = document.querySelector('snes-emulator');
    if (snes && typeof snes.getFullscreenCaptionsEnabled === 'function') {
      this.fullscreenCaptionsEnabled = !!snes.getFullscreenCaptionsEnabled();
      return;
    }
    this.fullscreenCaptionsEnabled = localStorage.getItem("LIVE_COACH_FULLSCREEN_CAPTIONS_ENABLED") !== "false";
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
    this.currentEnvironment = CURRENT_ENVIRONMENT;
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

    const liveCoach = this;
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
        const resolvedStartNode = liveCoach.resolveDesignSpaceNodeName(nodeName);
        if (!resolvedStartNode) {
          return liveCoach.buildNodeValidationError(nodeName, "nodeName");
        }

        const requestBody = { nodeName: resolvedStartNode, itemList };
        if (goalNode) {
          const resolvedGoalNode = liveCoach.resolveDesignSpaceNodeName(goalNode);
          if (!resolvedGoalNode) {
            return liveCoach.buildNodeValidationError(goalNode, "goalNode");
          }
          requestBody.goalNode = resolvedGoalNode;
        }

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
        const resolvedNodeName = liveCoach.resolveDesignSpaceNodeName(nodeName);
        if (!resolvedNodeName) {
          return liveCoach.buildNodeValidationError(nodeName, "nodeName");
        }

        let response = await fetch("https://sm-route-server-435712896720.us-west1.run.app/node/" + resolvedNodeName);
        return await response.json();
      },
      direction_to_point({goalCoords}) {
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
      capture_game_screenshot({ detail_level } = {}) {
        try {
          const snes = document.querySelector('snes-emulator');
          if (!snes) {
            return "Error: <snes-emulator> element not found.";
          }
          if (typeof snes.captureCoachScreenshot !== 'function') {
            return "Error: Screenshot capture is not available in the emulator.";
          }

          const chosenDetailLevel = detail_level === "detailed" ? "detailed" : "normal";
          const screenshot = snes.captureCoachScreenshot({ detailLevel: chosenDetailLevel });
          if (!screenshot || !screenshot.ok) {
            return `Error: ${screenshot && screenshot.error ? screenshot.error : "Unable to capture screenshot."}`;
          }

          return {
            responseText: `Screenshot captured (${screenshot.width}x${screenshot.height}, ${screenshot.mimeType}, ${screenshot.byteLength} bytes, detail=${chosenDetailLevel}).`,
            parts: [
              {
                inlineData: {
                  mimeType: screenshot.mimeType,
                  data: screenshot.data,
                },
              },
            ],
          };
        } catch (error) {
          return "Error: " + (error && error.message ? error.message : error);
        }
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
    if (!message) {
      return;
    }

    const isGameMessage = message.from === "Game";
    const isLivenessEnvironment = this.livenessEnvironments.has(this.currentEnvironment);
    const isLivenessEnabled = !!(this.ablationSettings && this.ablationSettings.liveness);
    if (isGameMessage && (!isLivenessEnvironment || !isLivenessEnabled)) {
      return;
    }

    if (message) {
      this.displayMessage(message.from, message.text, this.querySelector("#message_display"));

      try {
        this.beginSystemWork("System is thinking...");
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
                const functionCallMessage = this.createFunctionCallMessage(call);
                let result = undefined;
                let callError = null;
                try {
                  this.updateSystemWorkStatus(`Running ${call.name}...`);
                  result = await this.functionCallTools[call.name](call.args);
                } catch (error) {
                  console.warn("Error executing function call:", call.name, error);
                  callError = error && error.message ? error.message : String(error);
                  result = "Error: " + callError; // Return error message if function fails
                }

                this.finalizeFunctionCallMessage(functionCallMessage, result, callError);
                this.history.push(
                  this.buildTranscriptEntry(
                    "FunctionCallResults",
                    `name=${call.name}; args=${JSON.stringify(call.args)}; result=${JSON.stringify(this.summarizeFunctionResult(result))}`
                  )
                );

                const payload = this.buildFunctionResponsePayload(result);
                const functionResponsePart = {
                  functionResponse: {
                    name: call.name,
                    response: payload.response,
                  },
                };

                if (payload.parts.length) {
                  functionResponsePart.functionResponse.parts = payload.parts;
                }

                functionResponseParts.push(functionResponsePart);
              }
            }

            if (functionResponseParts.length) {
              this.updateSystemWorkStatus("System is thinking...");
              response = await this._chat.sendMessage({
                message: functionResponseParts,
              });

              this.displayMessage("Coach", response.text, this.querySelector("#message_display"));
            }
          }
        }

      } catch (error) {
        console.warn("Error sending message:", error);
        this.displayMessage("ErrorSystem", "Sorry, there was an error processing your message.", this.querySelector("#message_display"));
      } finally {
        this.endSystemWork();
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
      }
      // Removing from the style of the study

      // } else if (sender === "FunctionCallResults") {
      //   className = 'FunctionCall';
      //   sender = '🔧';
      //   isFunctionCallMessage = true;
      // }

      const messageElement = document.createElement("div");
      messageElement.className = "chat-message";
      // if (isFunctionCallMessage) {
      //   messageElement.classList.add("function-call-message");
      // }

      const header = emoji ? `<strong class="${className}"><span class="chat-emoji">${emoji}</span></strong>` : `<strong class="${className}">${sender}:</strong>`;

      // Check if message contains HTML (from FunctionCall with collapsible element)
      const isHTML = sender === '🔧' && message.includes('<details>');
      const parsedMessage = isHTML ? message : marked.parse(message);

      messageElement.innerHTML = `${header}${parsedMessage}`;
      chatElement.appendChild(messageElement);
      chatElement.scrollTop = chatElement.scrollHeight;

      // Hides Game and FunctionCall messages from the front-end, but saves the history to keep for transcripting the actions gone within the playtest
      if(sender === "Game") {
        messageElement.style.display = "none";
      }

      // Hide FunctionCall messages if toggle is off
      if(sender === "FunctionCallResults" && !this.functionCallsVisible) {
        messageElement.style.display = "none";
      }

      this.history.push(this.buildTranscriptEntry(sender, message));

      if (originalSender === 'Player' || originalSender === 'Coach') {
        this.showFullscreenCaption(originalSender, message);
      }

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
      <div id="system-thinking-indicator" class="system-thinking-indicator" role="status" aria-live="polite" aria-hidden="true" style="display:none;">
        <span class="thinking-dot" aria-hidden="true"></span>
        <span class="thinking-text">System is thinking...</span>
      </div>
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
        <button id="captions-toggle" type="button" class="control-btn" aria-pressed="true">Captions: ON</button>
        <button id="tts-toggle" type="button" class="tts-btn" aria-pressed="false">TTS: OFF</button>
        <button id="extra-controls-toggle" type="button" class="control-btn" aria-pressed="true">Admin: ON</button>
      </div>
      <div class="chat-secondary-row">
        <button id="download-transcript" type="button" class="control-btn">Download Transcript</button>
        <button id="function-calls-toggle" type="button" class="control-btn" aria-pressed="true">Function Calls: ON</button>
      </div>
    `;

    const playerInput = this.querySelector("#user-input");
    const micIcon = this.querySelector("#mic-icon");
    const extraControlsToggleBtn = this.querySelector("#extra-controls-toggle");
    const downloadTranscriptBtn = this.querySelector("#download-transcript");
    const functionCallsToggleBtn = this.querySelector("#function-calls-toggle");
    const captionsToggleBtn = this.querySelector("#captions-toggle");
    const ttsToggleBtn = this.querySelector("#tts-toggle");

    this.updateExtraControlsToggle(extraControlsToggleBtn, [downloadTranscriptBtn, functionCallsToggleBtn]);

    extraControlsToggleBtn?.addEventListener("click", () => {
      this.extraControlsVisible = !this.extraControlsVisible;
      localStorage.setItem("LIVE_COACH_EXTRA_CONTROLS_VISIBLE", this.extraControlsVisible ? "true" : "false");
      this.updateExtraControlsToggle(extraControlsToggleBtn, [downloadTranscriptBtn, functionCallsToggleBtn]);
    });

    downloadTranscriptBtn?.addEventListener("click", () => {
      this.downloadChatTranscript();
    });

    // ----- Function Calls Visibility Toggle Functionality -----
    this.updateFunctionCallsToggle(functionCallsToggleBtn);

    const applyFunctionCallsToggle = () => {
      this.functionCallsVisible = !this.functionCallsVisible;
      localStorage.setItem("LIVE_COACH_FUNCTION_CALLS_VISIBLE", this.functionCallsVisible ? "true" : "false");
      this.updateFunctionCallsToggle(functionCallsToggleBtn);
      
      // Update visibility of existing function call messages
      const messageDisplay = this.querySelector("#message_display");
      messageDisplay.querySelectorAll(".chat-message").forEach(msg => {
        const isFromFunctionCall = msg.innerHTML.includes("function-call-details");
        if (isFromFunctionCall) {
          msg.style.display = this.functionCallsVisible ? "" : "none";
        }
      });
    };

    functionCallsToggleBtn?.addEventListener("click", () => {
      applyFunctionCallsToggle();
    });

    // ----- Fullscreen Captions Toggle Functionality -----
    this.syncFullscreenCaptionsState();
    this.updateCaptionsToggle(captionsToggleBtn);

    const applyCaptionsToggle = () => {
      const snes = document.querySelector('snes-emulator');
      if (snes && typeof snes.toggleFullscreenCaptions === 'function') {
        this.fullscreenCaptionsEnabled = !!snes.toggleFullscreenCaptions();
      } else {
        this.fullscreenCaptionsEnabled = !this.fullscreenCaptionsEnabled;
        localStorage.setItem("LIVE_COACH_FULLSCREEN_CAPTIONS_ENABLED", this.fullscreenCaptionsEnabled ? "true" : "false");
      }
      this.updateCaptionsToggle(captionsToggleBtn);
    };

    captionsToggleBtn?.addEventListener("click", () => {
      applyCaptionsToggle();
    });

    const handleFullscreenCaptionsChanged = (event) => {
      if (event && event.detail && typeof event.detail.enabled === 'boolean') {
        this.fullscreenCaptionsEnabled = event.detail.enabled;
      } else {
        this.syncFullscreenCaptionsState();
      }
      this.updateCaptionsToggle(captionsToggleBtn);
    };
    window.addEventListener('live-coach-fullscreen-captions-changed', handleFullscreenCaptionsChanged);
    this._cleanupCaptionsSync = () => {
      window.removeEventListener('live-coach-fullscreen-captions-changed', handleFullscreenCaptionsChanged);
    };

    // ----- Text-to-Speech Toggle Functionality -----
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
    let ttsPausedByMicrophone = false; // Track if TTS was paused due to microphone input
    const micGamepadButtonIndices = [7]; // Switch controller mapping: ZR 7 (ZL reserved for captions)
    const ttsGamepadButtonIndices = [16]; // Switch home button mapping: 17
    let keyboardMicHeld = false;
    let gamepadMicHeld = false;
    let gamepadTtsToggleHeld = false;
    let gamepadPollId = null;

    const releaseMicPriority = () => {
      this.isMicPriorityActive = false;

      if (this.pendingCoachSpeechMessage) {
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
          }
        }
        ttsPausedByMicrophone = false;
        this.flushPendingCoachSpeech();
        return;
      }

      if (ttsPausedByMicrophone && this.ttsEnabled && window.speechSynthesis && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      ttsPausedByMicrophone = false;
    };

    const startMicHold = () => {
      if (!recognition || isListening) {
        return;
      }
      try {
        this.isMicPriorityActive = true;

        // Start recognition first to capture audio immediately
        recognition.start();
        isListening = true;
        this.setRecordingModeFeedback(true);
        micIcon.style.display = 'inline';
        
        // Pause TTS after recognition has started so it doesn't interfere with audio capture
        if (this.ttsEnabled && window.speechSynthesis && !window.speechSynthesis.paused) {
          window.speechSynthesis.pause();
          ttsPausedByMicrophone = true;
        }
      } catch (err) {
        // Ignore repeated starts while recognition is already active.
        this.setRecordingModeFeedback(false);
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

      releaseMicPriority();

      isListening = false;
      this.setRecordingModeFeedback(false);
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
        releaseMicPriority();
        isListening = false;
        this.setRecordingModeFeedback(false);
        micIcon.style.display = 'none';
      };
      recognition.onend = () => {
        releaseMicPriority();
        isListening = false;
        this.setRecordingModeFeedback(false);
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
    this.setRecordingModeFeedback(false);

    if (this._cleanupMicPolling) {
      this._cleanupMicPolling();
    }

    if (this._cleanupCaptionsSync) {
      this._cleanupCaptionsSync();
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