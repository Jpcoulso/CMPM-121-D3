// @deno-types="npm:@types/leaflet"
import leaflet from "leaflet";

// Styles
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./_leafletWorkaround.ts";

// Deterministic RNG
import luck from "./_luck.ts";

/* -------------------------------------------------------------------------- */
/*                               CONFIGURATION                                */
/* -------------------------------------------------------------------------- */

// Player starts at the classroom:
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

// Grid origin = Null Island (0,0)
const NULL_ISLAND = leaflet.latLng(0, 0);

// Grid
const TILE_DEGREES = 1e-4; // cell size
const INTERACTION_RADIUS_CELLS = 3;
const GAMEPLAY_ZOOM_LEVEL = 19;

// Token spawn rules
const CACHE_SPAWN_PROBABILITY = 0.10;
const VICTORY_THRESHOLD = 16;

/* -------------------------------------------------------------------------- */
/*                               DOM STRUCTURE                                */
/* -------------------------------------------------------------------------- */

const controlPanelDiv = document.createElement("div");
controlPanelDiv.id = "controlPanel";
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
document.body.append(statusPanelDiv);

/* -------------------------------------------------------------------------- */
/*                                 CELL ID                                    */
/* -------------------------------------------------------------------------- */

export interface CellID {
  iLat: number;
  iLng: number;
}

function cellKey(c: CellID): string {
  return `${c.iLat},${c.iLng}`;
}

function latLngToCellID(pos: leaflet.LatLng): CellID {
  return {
    iLat: Math.floor((pos.lat - NULL_ISLAND.lat) / TILE_DEGREES),
    iLng: Math.floor((pos.lng - NULL_ISLAND.lng) / TILE_DEGREES),
  };
}

function topLeftOfCell(c: CellID): leaflet.LatLng {
  return leaflet.latLng(
    NULL_ISLAND.lat + c.iLat * TILE_DEGREES,
    NULL_ISLAND.lng + c.iLng * TILE_DEGREES,
  );
}

function cellBounds(c: CellID): leaflet.LatLngBounds {
  const tl = topLeftOfCell(c);
  const br = leaflet.latLng(
    tl.lat + TILE_DEGREES,
    tl.lng + TILE_DEGREES,
  );
  return leaflet.latLngBounds(tl, br);
}

function centerOfCell(c: CellID): leaflet.LatLng {
  const tl = topLeftOfCell(c);
  return leaflet.latLng(
    tl.lat + TILE_DEGREES / 2,
    tl.lng + TILE_DEGREES / 2,
  );
}

/* -------------------------------------------------------------------------- */
/*                                  STATE                                     */
/* -------------------------------------------------------------------------- */

let playerLatLng = CLASSROOM_LATLNG;

// D3.c: Memento / Flyweight-style state for modified cells only
// Key: "iLat,iLng"  Value: number (token) or null (permanently empty)
const modifiedCells = new Map<string, number | null>();

let playerHeldToken: number | null = null;

/* -------------------------------------------------------------------------- */
/*                                MAP SETUP                                   */
/* -------------------------------------------------------------------------- */

const map = leaflet.map(mapDiv, {
  center: CLASSROOM_LATLNG,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
  scrollWheelZoom: false,
  dragging: true,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

const playerMarker = leaflet.marker(playerLatLng, {
  interactive: false,
});
playerMarker.bindTooltip("You are here").addTo(map);

/* Cell + token layers */
const cellLayer = leaflet.layerGroup().addTo(map);
const tokenLabelLayer = leaflet.layerGroup().addTo(map);

/* -------------------------------------------------------------------------- */
/*                           TOKEN GENERATION                                 */
/* -------------------------------------------------------------------------- */

function deterministicCellHasToken(c: CellID): boolean {
  return luck(cellKey(c)) < CACHE_SPAWN_PROBABILITY;
}

function deterministicCellTokenValue(c: CellID): number {
  const r = luck(cellKey(c) + "-val");
  const powers = [1, 2, 4, 8, 16];
  const weights = powers.map((p) => 1 / p);
  const total = weights.reduce((a, b) => a + b, 0);
  let cum = 0;
  for (let i = 0; i < powers.length; i++) {
    cum += weights[i] / total;
    if (r <= cum) return powers[i];
  }
  return 16;
}

/**
 * D3.c token lookup:
 * - If the cell has been modified, use modifiedCells (may be null).
 * - Otherwise, use the deterministic RNG as before.
 */
function tokenForCell(c: CellID): number | null {
  const k = cellKey(c);

  if (modifiedCells.has(k)) {
    return modifiedCells.get(k)!; // may be null = permanently empty
  }

  if (!deterministicCellHasToken(c)) return null;
  return deterministicCellTokenValue(c);
}

/* -------------------------------------------------------------------------- */
/*                               INTERACTIONS                                 */
/* -------------------------------------------------------------------------- */

function playerCell(): CellID {
  return latLngToCellID(playerLatLng);
}

function cellWithinInteraction(c: CellID): boolean {
  const p = playerCell();
  const dLat = Math.abs(c.iLat - p.iLat);
  const dLng = Math.abs(c.iLng - p.iLng);
  return Math.max(dLat, dLng) <= INTERACTION_RADIUS_CELLS;
}

function updateStatusPanel(msg?: string) {
  const inv = playerHeldToken === null ? "(empty)" : String(playerHeldToken);
  statusPanelDiv.innerHTML = `<strong>Inventory: ${inv}</strong>` +
    (msg ? `<div style="margin-top:4px">${msg}</div>` : "");
}

function checkVictory() {
  if (playerHeldToken !== null && playerHeldToken >= VICTORY_THRESHOLD) {
    updateStatusPanel(`Victory! You hold ${playerHeldToken}.`);

    leaflet
      .popup()
      .setLatLng(playerLatLng)
      .setContent(`<strong>Victory! You reached ${playerHeldToken}!</strong>`)
      .openOn(map);
  }
}

function onCellClicked(c: CellID) {
  if (!cellWithinInteraction(c)) {
    updateStatusPanel("Too far away.");
    return;
  }

  const k = cellKey(c);
  const cellToken = tokenForCell(c);

  // 1) Pick up: empty inventory, token present
  if (playerHeldToken === null && cellToken !== null) {
    playerHeldToken = cellToken;

    // D3.c: mark this cell as permanently empty (until we place something)
    modifiedCells.set(k, null);

    updateStatusPanel(`Picked up ${cellToken}`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // 2) Merge: same value in hand and cell
  if (
    playerHeldToken !== null &&
    cellToken !== null &&
    playerHeldToken === cellToken
  ) {
    const newVal = playerHeldToken * 2;
    playerHeldToken = newVal;

    // Cell consumed by merge → now empty (persistently)
    modifiedCells.set(k, null);

    updateStatusPanel(`Merged → ${newVal}`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // 3) Place: have a token, cell is empty
  if (playerHeldToken !== null && cellToken === null) {
    // Place token persistently at this cell
    modifiedCells.set(k, playerHeldToken);

    const placed = playerHeldToken;
    playerHeldToken = null;

    updateStatusPanel(`Placed ${placed} on the cell.`);
    renderVisibleCells();
    return;
  }

  // 4) Empty inventory + empty cell
  if (playerHeldToken === null && cellToken === null) {
    updateStatusPanel("No token here.");
    return;
  }

  // 5) Mismatch
  if (playerHeldToken !== null && cellToken !== null) {
    updateStatusPanel(
      `Mismatch: holding ${playerHeldToken}, cell has ${cellToken}`,
    );
    return;
  }
}

/* -------------------------------------------------------------------------- */
/*                                RENDERING                                   */
/* -------------------------------------------------------------------------- */

function renderVisibleCells() {
  cellLayer.clearLayers();
  tokenLabelLayer.clearLayers();

  const b = map.getBounds();

  const iLatStart = latLngToCellID(leaflet.latLng(b.getSouth(), 0)).iLat;
  const iLatEnd = latLngToCellID(leaflet.latLng(b.getNorth(), 0)).iLat + 1;

  const iLngStart = latLngToCellID(leaflet.latLng(0, b.getWest())).iLng;
  const iLngEnd = latLngToCellID(leaflet.latLng(0, b.getEast())).iLng + 1;

  for (let iLat = iLatStart; iLat <= iLatEnd; iLat++) {
    for (let iLng = iLngStart; iLng <= iLngEnd; iLng++) {
      const cell: CellID = { iLat, iLng };

      const rect = leaflet.rectangle(cellBounds(cell), {
        color: "#aaa",
        weight: 0.5,
        fillOpacity: 0.01,
      });

      rect.on("click", () => onCellClicked(cell));
      rect.addTo(cellLayer);

      const token = tokenForCell(cell);
      if (token !== null) {
        const icon = leaflet.divIcon({
          html:
            `<div class="token-text" style="pointer-events:none;background:white;padding:2px 4px;border-radius:4px;font-weight:bold">${token}</div>`,
          className: "",
          iconSize: [24, 18],
          iconAnchor: [12, 9],
        });

        leaflet
          .marker(centerOfCell(cell), { icon, interactive: false })
          .addTo(tokenLabelLayer);
      }
    }
  }

  updateStatusPanel();
}

/* -------------------------------------------------------------------------- */
/*                                   MOVE                                     */
/* -------------------------------------------------------------------------- */

function movePlayer(dLatCells: number, dLngCells: number) {
  playerLatLng = leaflet.latLng(
    playerLatLng.lat + dLatCells * TILE_DEGREES,
    playerLatLng.lng + dLngCells * TILE_DEGREES,
  );
  playerMarker.setLatLng(playerLatLng);
  map.panTo(playerLatLng);
  renderVisibleCells();
}

/* -------------------------------------------------------------------------- */
/*                                   UI                                       */
/* -------------------------------------------------------------------------- */

// Arrow buttons
const movementDiv = document.createElement("div");
movementDiv.style.display = "grid";
movementDiv.style.gridTemplateColumns = "repeat(3, 40px)";
movementDiv.style.gap = "5px";
movementDiv.style.marginTop = "8px";

const btnN = document.createElement("button");
btnN.textContent = "↑";
btnN.onclick = () => movePlayer(1, 0);

const btnS = document.createElement("button");
btnS.textContent = "↓";
btnS.onclick = () => movePlayer(-1, 0);

const btnE = document.createElement("button");
btnE.textContent = "→";
btnE.onclick = () => movePlayer(0, 1);

const btnW = document.createElement("button");
btnW.textContent = "←";
btnW.onclick = () => movePlayer(0, -1);

// 3×3 layout
movementDiv.appendChild(document.createElement("div"));
movementDiv.appendChild(btnN);
movementDiv.appendChild(document.createElement("div"));

movementDiv.appendChild(btnW);
movementDiv.appendChild(document.createElement("div"));
movementDiv.appendChild(btnE);

movementDiv.appendChild(document.createElement("div"));
movementDiv.appendChild(btnS);
movementDiv.appendChild(document.createElement("div"));

controlPanelDiv.innerHTML =
  `<button id="centerBtn">Center on player</button><hr>`;
controlPanelDiv.appendChild(movementDiv);

document.getElementById("centerBtn")!.onclick = () => {
  map.panTo(playerLatLng);
};

/* -------------------------------------------------------------------------- */
/*                                INIT                                        */
/* -------------------------------------------------------------------------- */

addEventListener("load", () => {
  updateStatusPanel("Move with arrows and click nearby cells.");
  renderVisibleCells();

  map.on("moveend", () => {
    renderVisibleCells();
  });
});
