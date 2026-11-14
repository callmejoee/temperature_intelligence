# Shape, Cut, Heat

Search a place in the United States, drop pins to draw a shape, and pick a past hour. The shape is cut into parts small enough to send. FortyGuard returns the heat inside each part, and the map draws those parts back together.

## Use it

1. Search for a place in the United States. The map moves there. A thin line shows the place, and the pins are what get read.
2. Click the map to drop pins. The shape closes around them, and every new pin adds a corner. Stay inside the United States.
3. Choose a past date and an hour. The latest date is yesterday.
4. Choose **Read the heat**.
5. FortyGuard returns a grid for that hour. Cooler cells are teal. Hotter cells are wine. The panel shows the coolest cell, the mean, the hottest cell, and how the cells spread.

## Data

- OpenStreetMap draws the base map. The shape is the one you pin.
- FortyGuard `heatmap` maps that shape. A premium plan allows 50 square miles per request, and a basic plan allows 10. A larger shape is cut into pieces under that limit. `heatmap_read` waits for each piece, and the tile grid is drawn as it arrives.
- One map asks for at most 16 pieces.

## Run

```bash
npm start
```

Open http://localhost:4173

Set `FORTYGUARD_API_KEY` in `.env`. Do not commit that file.

The earlier outing planner is the previous commit, if you want it back.
