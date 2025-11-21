// @deno-types="npm:@types/leaflet"
import leaflet from "leaflet";

// Style sheets
import "leaflet/dist/leaflet.css"; // supporting style for Leaflet
import "./style.css"; // student-controlled page style

// Fix missing marker images (starter patch)
import "./_leafletWorkaround.ts";

// Import our luck function (deterministic RNG provided by starter)
import luck from "./_luck.ts";

/* ----------------- Configuration (tweak these) ----------------- */
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // cell size
const INTERACTION_RADIUS_CELLS = 3; // player can interact about 3 cells away
const CACHE_SPAWN_PROBABILITY = 0.10; // base probability a cell contains a token
const MAX_TOKEN_POWER = 16; // maximum initial token (1,2,4,8,16)
const VICTORY_THRESHOLD = 16; // when player's held token >= this -> victory
/* ---------------------------------------------------------------- */

/* ----------------- Minimal DOM setup (keeps starter structure) ----------------- */
const controlPanelDiv = document.createElement("div");
controlPanelDiv.id = "controlPanel";
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
document.body.append(statusPanelDiv);
/* ----------------------------------------------------------------------------- */

/* ----------------- Game State (session-only) ----------------- */
// Keys are "i,j" where i = lat-index, j = lng-index relative to CLASSROOM_LATLNG
const pickedUpCells = new Set<string>(); // cells from which player has picked up tokens (session)
const placedTokens = new Map<string, number>(); // player-placed tokens for session
let playerHeldToken: number | null = null; // inventory: either null or a power-of-two

/* ----------------- Leaflet map + layers ----------------- */
const map = leaflet.map(mapDiv, {
  center: CLASSROOM_LATLNG,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
  scrollWheelZoom: false,
  dragging: true, // allow panning if desired (player can pan), but all visible cells will be rendered to viewport
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

const playerMarker = leaflet.marker(CLASSROOM_LATLNG, { interactive: false });
playerMarker.bindTooltip("That's you (fixed location)").addTo(map);

// Two layer groups: one for cell rectangles; one for token labels
const cellLayer = leaflet.layerGroup().addTo(map);
const tokenLabelLayer = leaflet.layerGroup().addTo(map);

/* ----------------- Utility helpers ----------------- */
// Convert latitude to integer cell index (relative to CLASSROOM_LATLNG)
function latToILat(lat: number): number {
  // cell index relative to classroom origin
  const delta = lat - CLASSROOM_LATLNG.lat;
  return Math.floor(delta / TILE_DEGREES);
}
function lngToILng(lng: number): number {
  const delta = lng - CLASSROOM_LATLNG.lng;
  return Math.floor(delta / TILE_DEGREES);
}
function iLatToLat(iLat: number): number {
  return CLASSROOM_LATLNG.lat + iLat * TILE_DEGREES;
}
function iLngToLng(iLng: number): number {
  return CLASSROOM_LATLNG.lng + iLng * TILE_DEGREES;
}
function cellKey(iLat: number, iLng: number) {
  return `${iLat},${iLng}`;
}

// Decide whether a deterministic cell should contain a token initially.
// Uses the provided luck() deterministic RNG with the cell key as seed.
function deterministicCellHasToken(iLat: number, iLng: number): boolean {
  const key = cellKey(iLat, iLng);
  return luck(key) < CACHE_SPAWN_PROBABILITY;
}

// Choose a token value for a deterministic cell (if it has a token).
// Returns a power-of-two: 1,2,4,8,... up to MAX_TOKEN_POWER
function deterministicCellTokenValue(iLat: number, iLng: number): number {
  // Use luck(`${key}-value`) to pick
  const key = cellKey(iLat, iLng) + "-val";
  const r = luck(key);

  // We'll bias toward smaller values: probability ∝ 1/power
  const powers: number[] = [];
  for (let p = 1; p <= MAX_TOKEN_POWER; p *= 2) powers.push(p);
  const weights = powers.map((p) => 1 / p);
  const total = weights.reduce((a, b) => a + b, 0);
  let cum = 0;
  for (let idx = 0; idx < powers.length; idx++) {
    cum += weights[idx] / total;
    if (r <= cum) return powers[idx];
  }
  return powers[powers.length - 1];
}

// Wrapper that accounts for session modifications: placedTokens override; pickedUpCells remove token
function tokenForCell(iLat: number, iLng: number): number | null {
  const key = cellKey(iLat, iLng);
  if (pickedUpCells.has(key)) return null;
  if (placedTokens.has(key)) return placedTokens.get(key)!;
  if (!deterministicCellHasToken(iLat, iLng)) return null;
  return deterministicCellTokenValue(iLat, iLng);
}

// Determine if a cell is within interaction radius of the player's fixed location.
function cellWithinInteraction(iLat: number, iLng: number): boolean {
  const playerILat = latToILat(CLASSROOM_LATLNG.lat); // should be 0, but compute robustly
  const playerILng = lngToILng(CLASSROOM_LATLNG.lng);
  const dLat = Math.abs(iLat - playerILat);
  const dLng = Math.abs(iLng - playerILng);
  const dist = Math.max(dLat, dLng); // Chebyshev distance on grid
  return dist <= INTERACTION_RADIUS_CELLS;
}

/* ----------------- UI helpers ----------------- */
function updateStatusPanel(message?: string) {
  const holdingText = playerHeldToken === null
    ? "Inventory: (empty)"
    : `Inventory: ${playerHeldToken}`;
  const msgText = message ? `<div style="margin-top:6px">${message}</div>` : "";
  statusPanelDiv.innerHTML = `<strong>${holdingText}</strong>${msgText}`;
}

/* ----------------- Core interactions ----------------- */
function onCellClicked(iLat: number, iLng: number) {
  const key = cellKey(iLat, iLng);
  if (!cellWithinInteraction(iLat, iLng)) {
    updateStatusPanel("Too far away to interact.");
    return;
  }

  const cellToken = tokenForCell(iLat, iLng);

  // 1) If player empty and cell has token -> pick up
  if (playerHeldToken === null && cellToken !== null) {
    playerHeldToken = cellToken;
    // mark cell as picked up
    pickedUpCells.add(key);
    // if it was a placed token, remove placed override
    placedTokens.delete(key);
    updateStatusPanel(`Picked up ${cellToken}.`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // 2) If player holds token and cell has equal token -> craft (merge)
  if (
    playerHeldToken !== null && cellToken !== null &&
    playerHeldToken === cellToken
  ) {
    const newValue = playerHeldToken * 2;
    playerHeldToken = newValue;
    pickedUpCells.add(key);
    placedTokens.delete(key);
    updateStatusPanel(`Merged to ${newValue}.`);
    renderVisibleCells();
    checkVictory();
    return;
  }

  // 3) If player empty and cell empty -> nothing
  if (playerHeldToken === null && cellToken === null) {
    updateStatusPanel("No token here.");
    return;
  }

  // 4) If player holds token and cell empty -> place
  if (playerHeldToken !== null && cellToken === null) {
    placedTokens.set(key, playerHeldToken);
    // ensure it's not in pickedUp (we just placed)
    pickedUpCells.delete(key);
    const placed = playerHeldToken;
    playerHeldToken = null;
    updateStatusPanel(`Placed ${placed} on the cell.`);
    renderVisibleCells();
    return;
  }

  // 5) If player holds token and cell has non-equal token -> show mismatch
  if (
    playerHeldToken !== null && cellToken !== null &&
    playerHeldToken !== cellToken
  ) {
    updateStatusPanel(
      `Mismatch: holding ${playerHeldToken}, cell has ${cellToken}.`,
    );
    return;
  }
}

/* ----------------- Rendering ----------------- */
// Render only the cells that appear in the current map bounds (so cells appear across the map viewport edge)
function renderVisibleCells() {
  cellLayer.clearLayers();
  tokenLabelLayer.clearLayers();

  const bounds = map.getBounds();
  // We'll compute iLat and iLng ranges that cover map bounds (rounded outward)
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  // convert to iLat / iLng relative to classroom
  const iLatStart = latToILat(south);
  const iLatEnd = latToILat(north) + 1; // inclusive; +1 to cover top edge cells
  const iLngStart = lngToILng(west);
  const iLngEnd = lngToILng(east) + 1;

  for (let iLat = iLatStart; iLat <= iLatEnd; iLat++) {
    for (let iLng = iLngStart; iLng <= iLngEnd; iLng++) {
      // compute geographic bounds for the cell
      const sLat = iLatToLat(iLat);
      const wLng = iLngToLng(iLng);
      const nLat = sLat + TILE_DEGREES;
      const eLng = wLng + TILE_DEGREES;

      // draw light rectangle for the cell (gives grid impression to the map edge)
      const rect = leaflet.rectangle([[sLat, wLng], [nLat, eLng]], {
        color: "#aaa",
        weight: 0.5,
        fillOpacity: 0.01,
        interactive: true,
      });
      rect.addTo(cellLayer);

      // click handler uses the integer indices
      rect.on("click", () => onCellClicked(iLat, iLng));

      // show token text if present
      const token = tokenForCell(iLat, iLng);
      if (token !== null) {
        // center of the cell
        const centerLat = (sLat + nLat) / 2;
        const centerLng = (wLng + eLng) / 2;

        // token shown as simple text (style can be changed in style.css)
        const html =
          `<div class="token-text" style="pointer-events:none; font-weight:bold; padding:2px 4px; border-radius:4px; background:rgba(255,255,255,0.95); box-shadow:0 1px 2px rgba(0,0,0,0.15)">${token}</div>`;
        const icon = leaflet.divIcon({
          html,
          className: "token-div-icon",
          iconSize: [30, 20],
          iconAnchor: [15, 10],
        });
        const marker = leaflet.marker([centerLat, centerLng], {
          icon,
          interactive: false,
        });
        marker.addTo(tokenLabelLayer);
      }
    }
  }

  // Update status UI to reflect inventory
  updateStatusPanel();
}

/* ----------------- Victory check ----------------- */
function checkVictory() {
  if (playerHeldToken !== null && playerHeldToken >= VICTORY_THRESHOLD) {
    updateStatusPanel(
      `Victory! You hold ${playerHeldToken} (>= ${VICTORY_THRESHOLD}).`,
    );
    // show a popup at player location
    leaflet
      .popup({ closeOnClick: true, autoClose: true })
      .setLatLng(CLASSROOM_LATLNG)
      .setContent(
        `<div style="font-weight:bold">Victory!</div><div>You have ${playerHeldToken}.</div>`,
      )
      .openOn(map);
  }
}

/* ----------------- Initial rendering + events ----------------- */
addEventListener("load", () => {
  // initial status
  updateStatusPanel(
    "Click nearby cells to pick up tokens. You can place or merge tokens.",
  );

  // initial render for the current viewport
  renderVisibleCells();

  // re-render when user pans/zooms (keeps the impression that cells cover viewport edges)
  map.on("moveend zoomend", () => {
    renderVisibleCells();
  });

  // center map on player if they click the control panel
  controlPanelDiv.innerHTML =
    `<button id="centerBtn">Center on classroom</button>`;
  controlPanelDiv.querySelector("#centerBtn")!.addEventListener("click", () => {
    map.panTo(CLASSROOM_LATLNG);
  });
});
