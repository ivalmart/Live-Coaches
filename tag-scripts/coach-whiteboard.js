import { marked } from "https://esm.run/marked";
import {
  maxBounds, bounds,
  abstractify_pos_global,
  mk_all_rooms_rect,
  mk_all_node_circles,
  pos_to_loc,
  update_pos
} from "../SNES9x-framework/map_tools.mjs";

class CoachWhiteboard extends HTMLElement {
  constructor() {
    super();
    // Copy of the Leaflet map structure. Currently just makes a new map when asked rather than retaining a map for the whole session
    this._map = null;          // Leaflet map instance for newly made map
    this._player = null;       // local player tracking  for map within whiteboard
    this._updateInterval = null;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this._clearMap();
  }

  render() {
    this.innerHTML = `
      <div class="whiteboard" id="whiteboard">
        <div class="whiteboard-placeholder">Whiteboard — the coach can write here</div>
      </div>
    `;
  }

  // API for Live Coach under whiteboard function call
  setContent(msg) {
    const wb = this.querySelector('#whiteboard');
    if (!wb) return;

    this._clearMap();

    const text = (msg === undefined || msg === null) ? '' : String(msg).trim();
    if (!text) {
      wb.innerHTML = '<div class="whiteboard-placeholder">Empty content</div>';
      return;
    }

    const lower = text.toLowerCase();

    // If the player's query is related to the map, the LC will just write "map" as a condition to enter in here
    if (lower === 'map' || lower.startsWith('map') || lower.includes('show map')) {
      wb.innerHTML = '';
      const mapDiv = document.createElement('div');
      mapDiv.id = 'whiteboard-map';
      mapDiv.style.width = '100%';
      mapDiv.style.height = '100%';
      wb.appendChild(mapDiv);
      this._createMap(mapDiv);
      return;
    }

    // For image URL rendering
    if (/^https?:\/\/.+\.(png|jpg|jpeg|gif|svg|webp)(\?.*)?$/i.test(text)) {
      wb.innerHTML = '';
      const img = document.createElement('img');
      img.src = text;
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      wb.appendChild(img);
      return;
    }

    // For Markdown and HTML rendering
    wb.innerHTML = '';
    try {
      wb.innerHTML = marked.parse(text);
    } catch (_) {
      wb.textContent = text;
    }
  }

  // Internal leaflet map creation only for inside the whiteboard
  _createMap(container) {
    const map = L.map(container, {
      maxBounds,
      crs: L.CRS.Simple,
    }).fitBounds(bounds);

    map.createPane('playerRangePane');
    map.getPane('playerRangePane').style.zIndex = 299;
    map.getPane('playerRangePane').style.pointerEvents = 'none';

    L.tileLayer(
      "https://bin0al.github.io/Super_Metroid_World_Map/Mapfiles/{z}/{x}/{y}.png",
      {
        minZoom: 3,
        maxZoom: 8,
        attribution: '<a href="https://www.snesmaps.com/">snesmaps.com</a>',
        detectRetina: true,
      }
    ).addTo(map);

    this._player = {
      x: 258, y: 562,
      marker: null, range: null,
      nodeList: [], closestNode: null
    };

    mk_all_rooms_rect(map);
    mk_all_node_circles(this._player, map);

    const emulator = document.querySelector('snes-emulator');
    if (emulator) {
      try {
        const dv = emulator.callDataView();
        if (dv) {
          const coords = abstractify_pos_global(dv);
          this._player.x = coords[0];
          this._player.y = coords[1];
        }
      } catch (_) { /* emulator may not be ready */ }
    }

    const start_loc = pos_to_loc([this._player.x, this._player.y]);
    this._player.marker = L.circle(start_loc, {
      radius: 0.2, color: 'hsl(322, 50%, 50%)',
    }).addTo(map);
    this._player.range = L.circle(start_loc, {
      radius: 0.5, color: 'hsl(50, 10%, 70%)',
      pane: 'playerRangePane',
    }).addTo(map);

    this._map = map;

    // Updated visualization of player position
    this._updateInterval = setInterval(() => {
      if (!emulator) return;
      try {
        const dv = emulator.callDataView();
        if (!dv) return;
        const coords = abstractify_pos_global(dv);
        this._player.x = coords[0];
        this._player.y = coords[1];
        update_pos(this._player);
      } catch (_) { /* emulator may not be ready */ }
    }, 100);
  }

  _clearMap() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    if (this._map) {
      try { this._map.remove(); } catch (_) { }
      this._map = null;
      this._player = null;
    }
  }
}

customElements.define('coach-whiteboard', CoachWhiteboard);
