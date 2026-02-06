# Project Guidelines

## Overview
AI-powered live coaching system for **Super Metroid** (SNES). A SNES emulator runs in-browser (WASM), reads game memory in real time, and feeds player state to a **Gemini** chatbot that proactively coaches the player. Built for an ablation study comparing coaching components.

## Architecture
Zero-build, single-page app using **vanilla Web Components** (no framework, no bundler). All dependencies loaded as ES modules from CDNs (Skypack, esm.run, unpkg).

### Components (in [tag-scripts/](tag-scripts/))
- **`<snes-emulator>`** — Loads ROM via snes9x WASM, renders to canvas, reads WRAM for game state (energy, missiles, items, position). Detects state changes and pushes to `<live-coach>`.
- **`<live-coach>`** — Gemini chat with function calling. System prompt = [prompts/coach-prompt.md](prompts/coach-prompt.md) + [prompts/SuperMetroid.md](prompts/SuperMetroid.md). Tool declarations in [assets/function-declarations.json](assets/function-declarations.json). Processes function calls in a loop until a text response.
- **`<sm-map>`** — Leaflet.js overlay of the Super Metroid world. Polls SNES memory every 100ms for player position, detects nearest routing node every 1s.
- **`<controller-mapping>`** — Keyboard mapping display (only component using Shadow DOM).

### Data Flow
```
ROM → snes9x WASM → WRAM DataView → state extraction → live-coach → Gemini API (+ function calls) → response displayed
                                    → sm-map (position polling → Leaflet markers)
```

### External Services
- **Gemini API** (`gemini-3-flash-preview`) — via `@google/genai` from esm.run
- **Route server** — `https://sm-route-server-435712896720.us-west1.run.app` (`POST /full_route`, `GET /node/{name}`)
- **Map tiles** — `https://bin0al.github.io/Super_Metroid_World_Map/Mapfiles/`

## Code Style
- Vanilla JS with ES module imports from CDNs — no npm, no bundler
- Web Components **without Shadow DOM** (except `<controller-mapping>`)
- JSON imports use import assertions: `import X from "file.json" with { "type": "json" }`
- SNES memory offsets are hex constants (e.g., `0x09C2` = energy, `0x09A4` = equipment bitmask, `0x079F` = area index)
- Game-state detection uses JSON string comparison of state objects

## Build and Test
No build step. Use the **Live Server** VS Code extension to serve the root directory and open [index.html](index.html).
The ROM file `assets/Super Metroid.sfc` must be present locally (not committed).

## Project Conventions
- **Prompt layering**: Generic coach behavior in [prompts/coach-prompt.md](prompts/coach-prompt.md), game-specific knowledge in [prompts/SuperMetroid.md](prompts/SuperMetroid.md). When adding a new game, create a new game-specific prompt file.
- **Function calling**: Gemini tool declarations live in [assets/function-declarations.json](assets/function-declarations.json). The coach runs a `while(response.functionCalls)` loop, resolving each tool before replying.
- **Save states**: Slots 4–9 are preloaded from [assets/sm_save_states/](assets/sm_save_states/) with specific progression points; slots 0–3 are dynamic.
- **Coordinate pipeline**: SNES WRAM → room-local pos → area offset → global map tiles → pixels → Leaflet lat/lng. Conversions in [SNES9x-framework/map_tools.mjs](SNES9x-framework/map_tools.mjs). Room/node data in [SNES9x-framework/all_rooms.json](SNES9x-framework/all_rooms.json) and [SNES9x-framework/all_nodes.json](SNES9x-framework/all_nodes.json).
- **`_LC-old-version/`** is the pre-refactor monolithic version — reference only, do not modify.
- **[SNES9x-framework/sm_global.py](SNES9x-framework/sm_global.py)** supports the separate Python route-planning server, not the browser app.

## Security
- **API key** in [api_key.txt](api_key.txt) — Google Gemini key loaded at runtime by `<live-coach>`. Never commit real keys; this file is for local dev only.
- **`evaluate_js_with_confirmation`** — Gemini function tool that runs `eval()` gated by `confirm()`. Treat with caution; this gives the AI arbitrary JS execution.

## Status (mid-refactor)
- `set_whiteboard_content` is declared in function-declarations.json but **not yet implemented**
- Passive emulator information retrieval is incomplete (see [README.md](README.md) TODOs)
