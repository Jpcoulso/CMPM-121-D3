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

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
controlPanelDiv.append(statusPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

/* -------------------------------------------------------------------------- */
/*                                CELL ID                                      */
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

// These represent the *live* in-memory state of visible modified cells
const pickedUpCells = new Set<string>();
const placedTokens = new Map<string, number>();
let playerHeldToken: number | null = null;

/* -------------------------------------------------------------------------- */
/*                           LOCAL STORAGE PERSISTENCE                        */
/* -------------------------------------------------------------------------- */

function saveGameState() {
  const state = {
    playerLat: playerLatLng.lat,
    playerLng: playerLatLng.lng,
    pickedUpCells: Array.from(pickedUpCells),
    placedTokens: Array.from(placedTokens.entries()),
    playerHeldToken,
  };

  localStorage.setItem("tokengo_save", JSON.stringify(state));
}

function loadGameState() {
  const raw = localStorage.getItem("tokengo_save");
  if (!raw) return;

  try {
    const data = JSON.parse(raw);

    playerLatLng = leaflet.latLng(data.playerLat, data.playerLng);

    pickedUpCells.clear();
    for (const k of data.pickedUpCells) pickedUpCells.add(k);

    placedTokens.clear();
    for (const [k, v] of data.placedTokens) placedTokens.set(k, v);

    playerHeldToken = data.playerHeldToken ?? null;
  } catch (err) {
    console.error("Save data corrupted:", err);
  }
}

/* -------------------------------------------------------------------------- */
/*                                MEMENTO                                     */
/* -------------------------------------------------------------------------- */
/**
 * Originator state for a single cell: did its token get picked up,
 * and is there a placed token there?
 */
interface CellState {
  pickedUp: boolean;
  placedToken: number | null;
}

/**
 * The Memento holds a snapshot of a CellState.
 */
class CellMemento {
  readonly state: CellState;

  constructor(state: CellState) {
    // defensive copy so external code can't mutate our snapshot
    this.state = { ...state };
  }
}

/**
 * Caretaker: stores mementos for cells that have scrolled off screen.
 */
class CellCaretaker {
  private history = new Map<string, CellMemento>();

  save(key: string, state: CellState) {
    this.history.set(key, new CellMemento(state));
  }

  restore(key: string): CellState | null {
    const m = this.history.get(key);
    if (!m) return null;
    // Return a copy so callers don't mutate the stored snapshot.
    return { ...m.state };
  }

  forget(key: string) {
    this.history.delete(key);
  }
}

// Single caretaker instance for all cells
const cellCaretaker = new CellCaretaker();

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

const playerMarker = leaflet.marker(playerLatLng, { interactive: false });
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

function tokenForCell(c: CellID): number | null {
  const k = cellKey(c);

  // Modified state wins over deterministic generation
  if (pickedUpCells.has(k)) return null;
  if (placedTokens.has(k)) return placedTokens.get(k)!;
  if (!deterministicCellHasToken(c)) return null;

  return deterministicCellTokenValue(c);
}

/* -------------------------------------------------------------------------- */
/*                               INTERACTIONS                                  */
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

  // Pick up
  if (playerHeldToken === null && cellToken !== null) {
    playerHeldToken = cellToken;
    pickedUpCells.add(k);
    placedTokens.delete(k);
    updateStatusPanel(`Picked up ${cellToken}`);
    renderVisibleCells();
    checkVictory();
    saveGameState();
    return;
  }

  // Merge
  if (
    playerHeldToken !== null &&
    cellToken !== null &&
    playerHeldToken === cellToken
  ) {
    const newVal = playerHeldToken * 2;
    playerHeldToken = newVal;
    pickedUpCells.add(k);
    placedTokens.delete(k);
    updateStatusPanel(`Merged → ${newVal}`);
    renderVisibleCells();
    checkVictory();
    saveGameState();
    return;
  }

  // Place
  if (playerHeldToken !== null && cellToken === null) {
    placedTokens.set(k, playerHeldToken);
    pickedUpCells.delete(k);
    playerHeldToken = null;
    updateStatusPanel("Placed token.");
    renderVisibleCells();
    saveGameState();
    return;
  }

  // Nothing here + empty inventory
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

/* -------------------------------------------------------------------------- */
/*                                RENDERING                                    */
/* -------------------------------------------------------------------------- */

function renderVisibleCells() {
  cellLayer.clearLayers();
  tokenLabelLayer.clearLayers();

  const b = map.getBounds();

  const iLatStart = latLngToCellID(leaflet.latLng(b.getSouth(), 0)).iLat;
  const iLatEnd = latLngToCellID(leaflet.latLng(b.getNorth(), 0)).iLat + 1;

  const iLngStart = latLngToCellID(leaflet.latLng(0, b.getWest())).iLng;
  const iLngEnd = latLngToCellID(leaflet.latLng(0, b.getEast())).iLng + 1;

  // Build visible cell key set
  const visibleKeys = new Set<string>();
  for (let iLat = iLatStart; iLat <= iLatEnd; iLat++) {
    for (let iLng = iLngStart; iLng <= iLngEnd; iLng++) {
      visibleKeys.add(`${iLat},${iLng}`);
    }
  }

  // -------------------------------------------------------------------
  // FLYWEIGHT + MEMENTO:
  //   - Only keep modified state for *visible* cells in pickedUpCells /
  //     placedTokens.
  //   - For modified cells that scroll off-screen, save a Memento in the
  //     caretaker so we can restore them later.
  // -------------------------------------------------------------------

  // 1. Figure out which modified cells are now off-screen
  const offscreenKeys = new Set<string>();
  for (const k of pickedUpCells) {
    if (!visibleKeys.has(k)) offscreenKeys.add(k);
  }
  for (const k of placedTokens.keys()) {
    if (!visibleKeys.has(k)) offscreenKeys.add(k);
  }

  // 2. Save Mementos for those off-screen modified cells
  for (const k of offscreenKeys) {
    const state: CellState = {
      pickedUp: pickedUpCells.has(k),
      placedToken: placedTokens.has(k) ? placedTokens.get(k)! : null,
    };
    cellCaretaker.save(k, state);
  }

  // 3. Trim live sets down to only visible modified cells
  const newPickedUp = new Set<string>();
  for (const k of pickedUpCells) {
    if (visibleKeys.has(k)) newPickedUp.add(k);
  }
  pickedUpCells.clear();
  for (const k of newPickedUp) pickedUpCells.add(k);

  const newPlaced = new Map<string, number>();
  for (const [k, v] of placedTokens) {
    if (visibleKeys.has(k)) newPlaced.set(k, v);
  }
  placedTokens.clear();
  for (const [k, v] of newPlaced) placedTokens.set(k, v);

  // -------------------------------------------------------------------
  // Draw visible cells (restoring from Mementos when necessary)
  // -------------------------------------------------------------------
  for (let iLat = iLatStart; iLat <= iLatEnd; iLat++) {
    for (let iLng = iLngStart; iLng <= iLngEnd; iLng++) {
      const cell: CellID = { iLat, iLng };
      const k = cellKey(cell);

      // If this visible cell has a saved Memento (from when it was off-screen),
      // restore its state into the live sets before we draw it.
      if (!pickedUpCells.has(k) && !placedTokens.has(k)) {
        const saved = cellCaretaker.restore(k);
        if (saved) {
          if (saved.pickedUp) pickedUpCells.add(k);
          if (saved.placedToken !== null) {
            placedTokens.set(k, saved.placedToken);
          }
          // We can forget it now that it's back under live management.
          cellCaretaker.forget(k);
        }
      }

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
          html: `<div class="token-text" style="
            pointer-events:none;
            background:white;
            padding:2px 4px;
            border-radius:4px;
            font-weight:bold;">
            ${token}
            </div>`,
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
/*                          MOVEMENT CONTROLLER API                           */
/* -------------------------------------------------------------------------- */

interface MovementController {
  start(): void; // begin listening for movement events
  stop(): void; // stop listening
}

/* -------------------------------------------------------------------------- */
/*                      BUTTON-BASED MOVEMENT CONTROLLER                      */
/* -------------------------------------------------------------------------- */

class ButtonMovementController implements MovementController {
  private intervalId: number | null = null;

  start() {
    // Buttons control movement directly (already implemented in your UI)
    // No polling needed.
  }

  stop() {
    // Nothing needed since movement comes from UI buttons
  }
}

/* -------------------------------------------------------------------------- */
/*                       GEOLOCATION MOVEMENT CONTROLLER                      */
/* -------------------------------------------------------------------------- */

class GeoMovementController implements MovementController {
  private watchId: number | null = null;

  start() {
    if (!navigator.geolocation) {
      alert("Geolocation not supported.");
      return;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const newLat = pos.coords.latitude;
        const newLng = pos.coords.longitude;
        movePlayerTo(newLat, newLng);
      },
      (err) => {
        console.error("GPS error:", err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 8000,
      },
    );
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 FACADE                                     */
/* -------------------------------------------------------------------------- */

class MovementFacade {
  private current: MovementController;

  constructor(defaultController: MovementController) {
    this.current = defaultController;
    this.current.start();
  }

  switchTo(controller: MovementController) {
    this.current.stop();
    this.current = controller;
    this.current.start();
  }
}

// Create the facade (default = button controls)
const movementSystem = new MovementFacade(new ButtonMovementController());

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
  saveGameState();
}

// New: used by geolocation controller
function movePlayerTo(lat: number, lng: number) {
  playerLatLng = leaflet.latLng(lat, lng);
  playerMarker.setLatLng(playerLatLng);
  map.panTo(playerLatLng);
  renderVisibleCells();
  saveGameState();
}

/* -------------------------------------------------------------------------- */
/*                                     UI                                     */
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

// Center button
const centerBtn = document.createElement("button");
centerBtn.textContent = "Center on player";
centerBtn.onclick = () => map.panTo(playerLatLng);
controlPanelDiv.appendChild(centerBtn);

// NEW GAME BUTTON
const newGameBtn = document.createElement("button");
newGameBtn.textContent = "New Game";
newGameBtn.style.marginBottom = "8px";

newGameBtn.onclick = () => {
  if (!confirm("Start a new game? All progress will be lost.")) return;
  resetGameState();
};

controlPanelDiv.appendChild(newGameBtn);

// Add movement mode toggle
const modeBtn = document.createElement("button");
modeBtn.textContent = "Switch to Geo Mode";

let usingGeo = false;

modeBtn.onclick = () => {
  if (!usingGeo) {
    // Allow the click event to finish first (required on iOS)
    setTimeout(() => {
      movementSystem.switchTo(new GeoMovementController());
    }, 0);

    modeBtn.textContent = "Switch to Button Mode";
    usingGeo = true;
  } else {
    movementSystem.switchTo(new ButtonMovementController());
    modeBtn.textContent = "Switch to Geo Mode";
    usingGeo = false;
  }
};

controlPanelDiv.appendChild(modeBtn);

// Horizontal line
controlPanelDiv.appendChild(document.createElement("hr"));

// Movement arrows
controlPanelDiv.appendChild(movementDiv);

// Inventory panel (statusPanelDiv)
controlPanelDiv.appendChild(statusPanelDiv);

/* -------------------------------------------------------------------------- */
/*                             RESET GAME STATE                               */
/* -------------------------------------------------------------------------- */

function resetGameState() {
  // Wipe localStorage
  localStorage.removeItem("tokengo_save");

  // Reset runtime state
  pickedUpCells.clear();
  placedTokens.clear();
  playerHeldToken = null;

  // Reset player position
  playerLatLng = CLASSROOM_LATLNG;
  playerMarker.setLatLng(playerLatLng);
  map.panTo(playerLatLng);

  // Re-render map
  updateStatusPanel("New game started.");
  renderVisibleCells();
}

/* -------------------------------------------------------------------------- */
/*                                     INIT                                   */
/* -------------------------------------------------------------------------- */

addEventListener("load", () => {
  loadGameState(); // <- NEW: restore state
  playerMarker.setLatLng(playerLatLng);
  map.panTo(playerLatLng);

  updateStatusPanel("Move with arrows and click nearby cells.");
  renderVisibleCells();

  map.on("moveend", () => {
    renderVisibleCells();
  });
});
