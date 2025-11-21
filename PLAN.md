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
