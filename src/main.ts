// @deno-types="npm:@types/leaflet"
import leaflet from "leaflet";

// Styles
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./_leafletWorkaround.ts";

// Deterministic RNG
import luck from "./_luck.ts";

/* --------------------------- Configuration --------------------------- */

// Player starts at classroom:
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

// Grid origin is Null Island:
const NULL_ISLAND = leaflet.latLng(0, 0);

// Grid config
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // size of each cell in degrees
const CACHE_SPAWN_PROBABILITY = 0.10;
const VICTORY_THRESHOLD = 16;

// “About three cells away” in meters.
// Approx: 1 degree latitude ≈ 111,320 meters.
const METERS_PER_DEG_LAT = 111_320;
const CELL_SIZE_METERS = TILE_DEGREES * METERS_PER_DEG_LAT;
const INTERACTION_RADIUS_CELLS = 3;
const INTERACTION_RADIUS_METERS = INTERACTION_RADIUS_CELLS * CELL_SIZE_METERS;

/* --------------------------- DOM Setup --------------------------- */
const controlPanelDiv = document.createElement("div");
controlPanelDiv.id = "controlPanel";
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
document.body.append(statusPanelDiv);

/* --------------------------- Game State --------------------------- */

const pickedUpCells = new Set<string>();
const placedTokens = new Map<string, number>();
let playerHeldToken: number | null = null;

// PLAYER POSITION (starts at classroom)
let playerLatLng = CLASSROOM_LATLNG;

/* --------------------------- Map Setup --------------------------- */

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

// Player marker
const playerMarker = leaflet.marker(playerLatLng, { interactive: false });
playerMarker.bindTooltip("You are here").addTo(map);

// Layers
const cellLayer = leaflet.layerGroup().addTo(map);
const tokenLabelLayer = leaflet.layerGroup().addTo(map);

/* --------------------------- Grid Helpers --------------------------- */

// Convert latitude/longitude to grid indices relative to NULL_ISLAND
function latToILat(lat: number): number {
  return Math.floor((lat - NULL_ISLAND.lat) / TILE_DEGREES);
}

function lngToILng(lng: number): number {
  return Math.floor((lng - NULL_ISLAND.lng) / TILE_DEGREES);
}

function iLatToLat(iLat: number): number {
  return NULL_ISLAND.lat + iLat * TILE_DEGREES;
}

function iLngToLng(iLng: number): number {
  return NULL_ISLAND.lng + iLng * TILE_DEGREES;
}

function cellKey(iLat: number, iLng: number) {
  return `${iLat},${iLng}`;
}

/* --------------------------- Token Generation --------------------------- */

function deterministicCellHasToken(iLat: number, iLng: number): boolean {
  return luck(cellKey(iLat, iLng)) < CACHE_SPAWN_PROBABILITY;
}

function deterministicCellTokenValue(iLat: number, iLng: number): number {
  const r = luck(cellKey(iLat, iLng) + "-val");
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

function tokenForCell(iLat: number, iLng: number): number | null {
  const key = cellKey(iLat, iLng);
  if (pickedUpCells.has(key)) return null;
  if (placedTokens.has(key)) return placedTokens.get(key)!;
  if (!deterministicCellHasToken(iLat, iLng)) return null;
  return deterministicCellTokenValue(iLat, iLng);
}

/* --------------------------- Interaction Radius --------------------------- */

// Check interaction based on real-world distance in meters
function cellWithinInteraction(iLat: number, iLng: number): boolean {
  // Center of this cell
  const centerLat = iLatToLat(iLat) + TILE_DEGREES / 2;
  const centerLng = iLngToLng(iLng) + TILE_DEGREES / 2;
  const cellCenter = leaflet.latLng(centerLat, centerLng);

  const distMeters = playerLatLng.distanceTo(cellCenter);
  return distMeters <= INTERACTION_RADIUS_METERS;
}

/* --------------------------- Status Panel --------------------------- */

function updateStatusPanel(message?: string) {
  const holding = playerHeldToken === null
    ? "Inventory: (empty)"
    : `Inventory: ${playerHeldToken}`;

  statusPanelDiv.innerHTML = `<strong>${holding}</strong>` +
    (message ? `<div style="margin-top:4px">${message}</div>` : "");
}

/* --------------------------- Interaction --------------------------- */

function onCellClicked(iLat: number, iLng: number) {
  const inRange = cellWithinInteraction(iLat, iLng);
  if (!inRange) {
    updateStatusPanel("Too far away.");
    return;
  }

  const key = cellKey(iLat, iLng);
  const cellToken = tokenForCell(iLat, iLng);

  // Pick up
  if (playerHeldToken === null && cellToken !== null) {
    playerHeldToken = cellToken;
    pickedUpCells.add(key);
    placedTokens.delete(key);
    updateStatusPanel(`Picked up ${cellToken}`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // Merge
  if (playerHeldToken !== null && cellToken === playerHeldToken) {
    const newVal = playerHeldToken * 2;
    playerHeldToken = newVal;
    pickedUpCells.add(key);
    placedTokens.delete(key);
    updateStatusPanel(`Merged to ${newVal}`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // Place
  if (playerHeldToken !== null && cellToken === null) {
    placedTokens.set(key, playerHeldToken);
    playerHeldToken = null;
    updateStatusPanel(`Placed token`);
    renderVisibleCells();
    return;
  }

  // Empty cell + empty inventory
  if (playerHeldToken === null && cellToken === null) {
    updateStatusPanel("No token here.");
    return;
  }

  // Mismatch
  if (playerHeldToken !== null && cellToken !== null) {
    updateStatusPanel(
      `Mismatch: holding ${playerHeldToken}, cell has ${cellToken}`,
    );
  }
}

/* --------------------------- Rendering --------------------------- */

function renderVisibleCells() {
  cellLayer.clearLayers();
  tokenLabelLayer.clearLayers();

  const bounds = map.getBounds();
  const iLatStart = latToILat(bounds.getSouth());
  const iLatEnd = latToILat(bounds.getNorth()) + 1;
  const iLngStart = lngToILng(bounds.getWest());
  const iLngEnd = lngToILng(bounds.getEast()) + 1;

  for (let iLat = iLatStart; iLat <= iLatEnd; iLat++) {
    for (let iLng = iLngStart; iLng <= iLngEnd; iLng++) {
      const sLat = iLatToLat(iLat);
      const wLng = iLngToLng(iLng);
      const nLat = sLat + TILE_DEGREES;
      const eLng = wLng + TILE_DEGREES;

      const rect = leaflet.rectangle([[sLat, wLng], [nLat, eLng]], {
        color: "#aaa",
        weight: 0.5,
        fillOpacity: 0.01,
      });

      rect.on("click", () => onCellClicked(iLat, iLng));
      rect.addTo(cellLayer);

      const token = tokenForCell(iLat, iLng);
      if (token !== null) {
        const centerLat = (sLat + nLat) / 2;
        const centerLng = (wLng + eLng) / 2;

        const html =
          `<div class="token-text" style="pointer-events:none;font-weight:bold;padding:2px 4px;background:white;border-radius:4px">${token}</div>`;

        const icon = leaflet.divIcon({
          html,
          className: "",
          iconSize: [24, 18],
          iconAnchor: [12, 9],
        });

        leaflet.marker([centerLat, centerLng], { icon, interactive: false })
          .addTo(
            tokenLabelLayer,
          );
      }
    }
  }

  updateStatusPanel();
}

/* --------------------------- Victory --------------------------- */

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

/* --------------------------- Movement Buttons --------------------------- */

function movePlayer(dLatCells: number, dLngCells: number) {
  const newLat = playerLatLng.lat + dLatCells * TILE_DEGREES;
  const newLng = playerLatLng.lng + dLngCells * TILE_DEGREES;

  playerLatLng = leaflet.latLng(newLat, newLng);
  playerMarker.setLatLng(playerLatLng);
  map.panTo(playerLatLng);

  renderVisibleCells();
}

// Build arrow button grid
const movementDiv = document.createElement("div");
movementDiv.className = "movement-buttons";
movementDiv.style.marginTop = "10px";
movementDiv.style.display = "grid";
movementDiv.style.gridTemplateColumns = "repeat(3, 40px)";
movementDiv.style.gap = "5px";

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

/* --------------------------- Initial Render --------------------------- */

addEventListener("load", () => {
  updateStatusPanel("Click nearby cells or move with buttons.");
  renderVisibleCells();
});
