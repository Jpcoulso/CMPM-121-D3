# D3: {game title goes here}

# Game Design Vision

for this demo project I will be implementing a "pokemon go" meets "2048" type game. Players will see a grid of tokens around their current location on a map, they can interact with tokens in order to combine them or hold them and only when they are holding a sufficiently large token will they win. only tokens of the same value can be combined. only tokens within a certain distance of the player can be interacted with.

# Technologies

- TypeScript for most game code, little to no explicit HTML, and all CSS collected in common `style.css` file
- Deno and Vite for building
- GitHub Actions + GitHub Pages for deployment automation

# Assignments

## D3.a: Core mechanics (token collection and crafting)

Key technical challenge: Can you assemble a map-based user interface using the Leaflet mapping framework?
Key gameplay challenge: Can players collect and craft tokens from nearby locations to finally make one of sufficiently high value?

### Steps

- [x] copy main.ts to reference.ts for future reference
- [x] delete everything in main.ts
- [x] put a basic leaflet map on the screen
- [x] draw the player's location on the map
- [x] draw a rectangle representing one cell on the map
- [x] use loops to draw a whole grid of cells on the map
- [x] populate cells with numbers
- [x] add inventory system
- [x] make it so number tokens can be picked up
- [x] make it so number tokens can be placed and combined

## D3.b: Core mechanics (Player movement and earth spanning coordinate system)

- [x] implement player movement
- [x] anchor global coordinate system at null island
- [x] make tokens memoryless
- [x] raise threshhold for winning the game (make the value higher)

## D3.c: Core mechanics (Use flyweight and memento pattern to give cells persistent memory)

- [x] identify intrinsic state of a cell (value, type)
- [x] identify extrinsic state of a cell (global coordinates, screen position, visible/not)
- [x] create a CellFlyweight type to store intrinsic state
- [x] implement CellFlyweightFactory with internal cache
- [x] refactor cell creation so grid rendering requests flyweights from the factory
- [x] remove per-cell intrinsic data from the main grid structure
- [x] update rendering functions so they accept extrinsic state as parameters
- [x] add debugging counters to confirm flyweights are reused
- [x] profile memory usage with large fake grids to ensure flyweights are reducing allocations

- [] apply memento pattern to preserve the state of modified cells when not visible on screen
- [] design a minimal CellMemento to store modified cell state
- [] implement a CellCaretaker storing mementos in a Map<string, CellMemento>
- [] whenever a cell is modified (pickup/place/combine), store a memento
- [] update grid-render logic to check caretaker first when rendering a cell
- [] restore modified state by applying memento + flyweight during rendering
- [] clear temporary cell objects when they scroll off-screen
- [] verify that removed temporary data is correctly rebuilt using mementos
- [] add optional serialization function (exportState()) to prepare for D3.d
- [] test manually by modifying a cell, scrolling away, and coming back to ensure persistence
