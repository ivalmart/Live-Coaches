import all_rooms from "../SNES9x-framework/all_rooms.json" with { type: "json" };
import all_nodes from "../SNES9x-framework/all_nodes.json" with { type: "json" };


export const map_area_names = {
  0: "Crateria",
  1: "Brinstar",
  2: "Norfair",
  3: "Wrecked Ship",
  4: "Maridia",
  5: "Tourian",
  6: "Ceres",
  7: "Debug",
};

export const map_area_offsets = {
  0: [3, 10],
  1: [0, 28],
  2: [31, 48],
  3: [37, 0],
  4: [28, 28],
  5: [0, 10],
  //Out of bounds
  6: [0, -10],
  7: [0, 0],
};

export const crateria2_offset = [7, 0];
export const crateria2_rooms = [
  "East_Ocean",
  "Forgotten_Highway",
  "Crab_Maze",
  "Crateria_Power_Door",
  "Crateria_Maridia_Shaft",
];

// Base leaflet map
const base = {
  width: 18432, // pixels
  height: 16896, // pixels
  pixelsPerDegree: 128,
  offsetY: -14336,
  offsetX: -1280,
}
const padding = Math.min(base.width, base.height) / 2;

export const bounds = [
  [
    base.offsetY / base.pixelsPerDegree,
    base.offsetX / base.pixelsPerDegree,
  ],
  [
    (base.offsetY + base.height) / base.pixelsPerDegree,
    (base.offsetX + base.width) / base.pixelsPerDegree,
  ],
];
export const maxBounds = [
  [
    (base.offsetY - padding) / base.pixelsPerDegree,
    (base.offsetX - padding) / base.pixelsPerDegree,
  ],
  [
    (base.offsetY + base.height + padding) / base.pixelsPerDegree,
    (base.offsetX + base.width + padding) / base.pixelsPerDegree,
  ],
];

// ----- MAP FUNCTIONS (alphabetical) -----

function abstractify_pos(dv) {  
  const x_radius = dv.getInt16(0x0afe, true);
  const y_radius = dv.getInt16(0x0b00, true);
  const x_center = dv.getInt16(0x0af6, true);
  const y_center = dv.getInt16(0x0afa, true);
  const top = (y_center - y_radius) / 16;
  const left = (x_center - y_radius) / 16;
  return [left, top];
}

export function abstractify_pos_global(dv, map_area_offsets) {
  // Area pos
  const area_index = dv.getUint8(0x079F);
  const aoffset = map_area_offsets[area_index];
  const area_pos = [16 * aoffset[0], 16 * aoffset[1]];
  // Map pos
  const map_x = dv.getUint8(0x07A1);
  const map_y = dv.getUint8(0x07A3);
  const map_pos = [16 * map_x, 16 * map_y];
  // Room pos
  const room_pos = abstractify_pos(dv);
  const pos = [area_pos[0] + map_pos[0] + room_pos[0], area_pos[1] + map_pos[1] + room_pos[1]]
  return pos;
}

// --- Adjacent node detection and closest node highlighting ---
export function adjacentNodeDetection(player) {
  const playerLoc = pos_to_loc([player.x, player.y]);
  const radius = player.range.getRadius();
  // Find all adjacent nodes within radius
  const adjacent = player.nodeList.filter(obj => latLngDistance(obj.loc, playerLoc) <= radius);
  // console.log("Adjacent nodes:", adjacent.map(obj => obj.name));
  const adjacentNames = adjacent.map(obj => obj.name);
  // Find the closest node among all nodes (not just adjacent)
  let closest = null;
  let minDist = Infinity;
  for (const obj of adjacent) {
    const dist = latLngDistance(obj.loc, playerLoc);
    if (dist < minDist) {
      minDist = dist;
      closest = obj;
    }
  }
  // Color code: green for closest node, blue for others
  if(closest != null) {
    player.nodeList.forEach(obj => {
      if (obj === closest) {
        obj.circ.setStyle({ color: 'hsl(100, 100%, 50%)' }); // green
        player.closestNode = obj.name;
      } else {
        obj.circ.setStyle({ color: '#3388ff' }); // blue
      }
    });
  }
}

// Returns the calculation values for Samus's positions within the game map created by Ross
export function calculate_samus_pos(dv) {
  let x = dv.getUint8(0x0b04);
  let y = dv.getUint8(0x0b06);  
  return abstractify_pos_global(dv, map_area_offsets);
}

// Returns the current player's room location of the game area based on the address
// given by the room pointer that's compared by the room's memory addresses (shifted into )
export function get_samus_room(address, rooms) {
  for (const [room_name, room_info] of rooms) {
    const mem_addr = room_info["Memory_Address"] & 0xffff;
      if (address == mem_addr) {
        return room_name;
      }
    }
  return null;
}

// Function to calculate distance between two [lat, lng] points (Euclidean for small distances)
function latLngDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function mk_room_rect(map, room_name) {
  const pixels_per_maptile = 256;
  const room_info = all_rooms[room_name];
  const r = room_info["Region"];

  let rect_start_mt = room_info["Map_Pos"];
  rect_start_mt = [
    rect_start_mt[0] + map_area_offsets[r][0],
    rect_start_mt[1] + map_area_offsets[r][1],
  ];
  if (crateria2_rooms.includes(room_name)) {
    rect_start_mt[0] += crateria2_offset[0];
    rect_start_mt[1] += crateria2_offset[1];
  }

  const start_pxy = [
    rect_start_mt[0] * pixels_per_maptile,
    rect_start_mt[1] * pixels_per_maptile,
  ];

  const end_pxy = [
    start_pxy[0] + room_info["Extent"][0] * pixels_per_maptile,
    start_pxy[1] + room_info["Extent"][1] * pixels_per_maptile,
  ];

  const rect = L.rectangle([pxy_to_loc(start_pxy), pxy_to_loc(end_pxy)], {
    color: `hsl(${(360 * r) / 5}, 50%, 50%, 35%)`,
  }).addTo(map);

  rect.bindTooltip(
    `${room_name.replaceAll("_", " ")}, ${map_area_names[r]}`
  );
}

export function mk_all_rooms_rect(map) {
  Object.keys(all_rooms).forEach(room_name => mk_room_rect(map, room_name));
}

function mk_node_circle(player, map, node_name) {
  const pos = all_nodes[node_name];
  const loc = pos_to_loc(pos)
  const circ = L.circle(loc, {
    radius: 0.2}).addTo(map);
    // Store for proximity checking
    player.nodeList.push({ circ, loc, name: node_name }
  );

  //TODO: add click callback to write goal.json
  // circ.bindTooltip(
  //   `${node_name.replaceAll("_", " ")}`
  // );
  // circ.on('click', (event) => {
  //   fetch(node_name); // Will Fail!
  //   document.getElementById("goal").innerHTML = node_name;
  // });
}

export function mk_all_node_circles(player, map) {
  Object.keys(all_nodes).forEach(node_name => mk_node_circle(player, map, node_name));
}

// Convert from pixel xy coords to the map coords
// which expects y,x degrees
function pxy_to_loc(pxy) {
  return [
    (base.offsetY + base.height - pxy[1]) / base.pixelsPerDegree,
    (base.offsetX + pxy[0]) / base.pixelsPerDegree,
  ];
}

// was in original code from Ross, idk what it does now
// function pos_list_to_loc(pos_list) {
//   return pos_list.map(pos_to_loc)
// }

export function pos_to_loc(pos) {
  return pxy_to_loc([pos[0] * 16, pos[1] * 16])
}

export function update_pos(player) {
  const loc = pos_to_loc([player.x, player.y]);
  player.marker.setLatLng(loc);
  player.range.setLatLng(loc);
}