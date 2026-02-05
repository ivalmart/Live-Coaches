import { maxBounds, bounds,
  adjacentNodeDetection,
  abstractify_pos_global,
  mk_all_rooms_rect,
  mk_all_node_circles,
  pos_to_loc,
  update_pos
} from "../SNES9x-framework/map_tools.mjs"; // Super Nintendo Map Tools Handler

// Highly dependent on snes-emulator.js
class SuperMetroidMap extends HTMLElement {
  constructor() {
    super();
    this.player = { // set default settings for map
      x: 258, 
      y: 562, // coordinates
      marker: null, // pink circle indicator on map to show player
      range: null, // white circle indicator to show player range
      nodeList: [], // list of associated nodes within range
      closestNode: "Landing_Site_Ship" // closest node to player
    };
    this.emulatorReference = null; 
  }

  // called each time component is added onto document
  connectedCallback() {
    this.emulatorReference = document.querySelector('snes-emulator');
    this.render();
    this.initMap();
  }

  initMap() {
    const map = L.map(this.querySelector('#sm-map'), {
      maxBounds: maxBounds,
      crs: L.CRS.Simple,
    }).fitBounds(bounds);

    // Create a custom pane for the player range circle, behind markers
    map.createPane('playerRangePane');
    map.getPane('playerRangePane').style.zIndex = 299;
    map.getPane('playerRangePane').style.pointerEvents = 'none';

    L.tileLayer("https://bin0al.github.io/Super_Metroid_World_Map/Mapfiles/{z}/{x}/{y}.png", {
      minZoom: 3,
      maxZoom: 8,
      attribution: '<a href="https://www.snesmaps.com/">Base Map from snesmaps.com</a>',
      detectRetina: true,
    }).addTo(map);

    // Setting up everything
    mk_all_rooms_rect(map);
    mk_all_node_circles(this.player, map);

    // starting position for player (arbitrary)
    const start_loc = pos_to_loc([this.player.x, this.player.y]);
    this.player.marker = L.circle(start_loc, {  // init player marker
      radius: 0.2, color: `hsl(322, 50%, 50%)`,
    }).addTo(map);
    this.player.range = L.circle(start_loc, { // init player range
      radius: 0.5, color: `hsl(50, 10%, 70%)`,
      pane: 'playerRangePane'
    }).addTo(map);

    // Constant updates
    setInterval(() => {
      this.update();
      update_pos(this.player);
    }, 100);
    setInterval(() => adjacentNodeDetection(this.player), 1000);
  }

  update() {
    if (!this.emulatorReference) {
      return;
    }
    let dv = this.emulatorReference.callDataView();
    this.player.x = dv.getUint8(0x09A2, true);
    this.player.y = dv.getUint8(0x09A4, true);
    
    const coords = abstractify_pos_global(dv);
    this.player.x = coords[0], this.player.y = coords[1];
    document.querySelector('snes-emulator').updatePlayerState();
  }

  render() {
    this.innerHTML = `
      <link rel="stylesheet" href="../style.css"/>
      <div class="map_style">
        <div id="sm-map" style="width: 600px; height: 600px; margin: auto;"></div>
      </div>
    `;
  }
}
customElements.define('sm-map', SuperMetroidMap);