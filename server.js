import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 4173;

const MCP_URL = "https://tos-mcp.app.fortyguard.com/mcp";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "ShapeCutHeat/1.0 (local heat map)";
const HALF_METERS = 500;
const MAX_PIECES = 16;
const SQUARE_METERS_PER_MILE = 2589988.110336;
const knownPlaces = new Map();
const jobs = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

app.get("/api/health", (_req, res) => {
  res.json({ places: "openstreetmap", fortyguard: Boolean(process.env.FORTYGUARD_API_KEY) });
});

app.get("/api/suggest", async (req, res) => {
  try {
    const input = cleanText(req.query.q, 120);
    if (input.length < 2) {
      res.json({ suggestions: [] });
      return;
    }
    res.json({ suggestions: await searchUnitedStates(input) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/field", async (req, res) => {
  try {
    const shape = readShape(req.body);
    const limit = await areaLimit();
    const pieces = cutShape(shape.polygon, limit.maxM2);
    if (!pieces.length) {
      const error = new Error("That place has no area to map.");
      error.status = 400;
      throw error;
    }
    if (pieces.length > MAX_PIECES) {
      const error = new Error(`That place needs ${pieces.length} pieces. ${MAX_PIECES} is the most for one map.`);
      error.status = 400;
      throw error;
    }
    const record = {
      id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      state: "running",
      done: 0,
      total: pieces.length,
      batches: [],
      stats: null,
      error: null,
      place: { name: shape.place.name, lat: shape.lat, lng: shape.lng },
      date: shape.date,
      time: shape.time,
    };
    jobs.set(record.id, record);
    if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
    runField(record, pieces, shape);
    res.json({ jobId: record.id, total: pieces.length, limitMi2: limit.miles });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/field/:id", (req, res) => {
  const record = jobs.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: "That map is no longer running." });
    return;
  }
  const after = Number(req.query.after);
  const start = Number.isInteger(after) && after > 0 ? after : 0;
  res.json({
    state: record.state,
    done: record.done,
    total: record.total,
    error: record.error,
    stats: record.stats,
    batches: record.batches.slice(start),
    place: record.place,
    date: record.date,
    time: record.time,
  });
});

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const server = app.listen(port, () => {
    console.log(`Shape, Cut, Heat listening on http://localhost:${port}`);
  });
  server.requestTimeout = 300000;
}

export { buildPieces, cutShape };

function fortyguardKey() {
  const key = process.env.FORTYGUARD_API_KEY;
  if (!key) {
    const error = new Error("Add FORTYGUARD_API_KEY to the .env file.");
    error.status = 503;
    throw error;
  }
  return key;
}

async function searchUnitedStates(query) {
  const url = new URL(NOMINATIM);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "8");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("q", query);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" } });
  if (!response.ok) {
    const error = new Error("Place search could not be completed.");
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const rows = await response.json();
  const suggestions = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const place = placeFromNominatim(row);
    if (!place) continue;
    knownPlaces.set(place.id, place);
    suggestions.push(publicPlace(place));
  }
  return suggestions;
}

function placeFromNominatim(row) {
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  const country = String(row.address?.country_code || "").toLowerCase();
  if (country !== "us" || !isInUnitedStates(lat, lng)) return null;
  const osmType = String(row.osm_type || "");
  const osmId = String(row.osm_id || "");
  if (!/^(node|way|relation)$/.test(osmType) || !/^\d+$/.test(osmId)) return null;
  const name = row.name || String(row.display_name || "").split(",")[0] || "Place";
  const geometry = usableGeometry(row.geojson);
  return {
    id: `${osmType}:${osmId}`,
    name,
    address: row.display_name || name,
    lat,
    lng,
    geometry,
    mapsUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
  };
}

function isInUnitedStates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const continental = lat >= 24.396308 && lat <= 49.384358 && lng >= -124.848974 && lng <= -66.885444;
  const alaska = lat >= 51 && lat <= 71.6 && ((lng >= -179.9 && lng <= -129) || (lng >= 172 && lng <= 180));
  const hawaii = lat >= 18.86 && lat <= 22.24 && lng >= -160.25 && lng <= -154.8;
  return continental || alaska || hawaii;
}

function publicPlace(place) {
  return {
    placeId: place.id,
    name: place.name,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    mapsUrl: place.mapsUrl,
    outline: place.geometry ? outlineGeometry(place.geometry) : null,
  };
}

function readShape(body) {
  const ring = shapeRing(body?.ring);
  const polygon = { type: "Polygon", coordinates: [orientRing(ring, true)] };
  const date = String(body?.date || "");
  const time = String(body?.time || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "2021-01-01" || date > daysAgo(1)) {
    const error = new Error("Choose a date from 2021 through yesterday.");
    error.status = 400;
    throw error;
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    const error = new Error("Choose an hour.");
    error.status = 400;
    throw error;
  }
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute !== 0) {
    const error = new Error("Choose an hour.");
    error.status = 400;
    throw error;
  }
  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const lng = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  const name = cleanText(body?.name, 80) || "Drawn shape";
  return {
    place: { name, lat, lng, geometry: polygon },
    polygon,
    lat,
    lng,
    date,
    time: `${String(hour).padStart(2, "0")}:00`,
  };
}

function shapeRing(points) {
  if (!Array.isArray(points) || points.length < 3) {
    const error = new Error("Drop at least three pins.");
    error.status = 400;
    throw error;
  }
  const ring = points.map((point) => {
    const lng = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!isInUnitedStates(lat, lng)) {
      const error = new Error("Keep the shape inside the United States.");
      error.status = 400;
      throw error;
    }
    return [lng, lat];
  });
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function cutShape(polygon, maxM2) {
  const pieces = [];
  const waiting = [polygon.coordinates[0]];
  while (waiting.length) {
    const ring = waiting.shift();
    const area = polygonArea([ring]);
    if (area < 20000) continue;
    if (area <= maxM2 * 0.9 && ring.length <= 48) {
      pieces.push({ polygon: { type: "Polygon", coordinates: [ring] }, granularity: area > 5e6 ? 100 : 60 });
      continue;
    }
    const box = ringBbox(ring);
    const midLat = (box.minLat + box.maxLat) / 2;
    const width = (box.maxLng - box.minLng) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const height = (box.maxLat - box.minLat) * 111320;
    const splitLng = width >= height;
    const middle = splitLng ? (box.minLng + box.maxLng) / 2 : (box.minLat + box.maxLat) / 2;
    const west = splitLng ? { ...box, maxLng: middle } : { ...box, maxLat: middle };
    const east = splitLng ? { ...box, minLng: middle } : { ...box, minLat: middle };
    const left = clipRing(ring, west);
    const right = clipRing(ring, east);
    if (!left || !right || waiting.length + pieces.length > 40) {
      const error = new Error("That shape is too large to map in one pass.");
      error.status = 400;
      throw error;
    }
    waiting.push(left, right);
  }
  return pieces;
}

function clipRing(ring, box) {
  let output = ring.slice(0, -1);
  output = clipEdge(output, (point) => point[0] >= box.minLng, (start, end) => crossX(start, end, box.minLng));
  output = clipEdge(output, (point) => point[0] <= box.maxLng, (start, end) => crossX(start, end, box.maxLng));
  output = clipEdge(output, (point) => point[1] >= box.minLat, (start, end) => crossY(start, end, box.minLat));
  output = clipEdge(output, (point) => point[1] <= box.maxLat, (start, end) => crossY(start, end, box.maxLat));
  if (output.length < 3) return null;
  return orientRing([...output, output[0]], true);
}

function clipEdge(points, inside, crossing) {
  if (!points.length) return [];
  const result = [];
  let previous = points[points.length - 1];
  for (const current of points) {
    const previousInside = inside(previous);
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) result.push(crossing(previous, current));
      result.push(current);
    } else if (previousInside) {
      result.push(crossing(previous, current));
    }
    previous = current;
  }
  return result;
}

function crossX(start, end, lng) {
  const span = end[0] - start[0] || 1;
  const t = (lng - start[0]) / span;
  return [lng, start[1] + (end[1] - start[1]) * t];
}

function crossY(start, end, lat) {
  const span = end[1] - start[1] || 1;
  const t = (lat - start[1]) / span;
  return [start[0] + (end[0] - start[0]) * t, lat];
}

function squarePolygon(lat, lng, halfMeters) {
  const dLat = halfMeters / 111320;
  const dLng = halfMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [[
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat],
    ]],
  };
}

async function areaLimit() {
  const response = await fetch("https://api.fortyguard.com/v1/system/fetch-api-key-usage", {
    method: "POST",
    headers: {
      "api-key": fortyguardKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ api_key: fortyguardKey() }),
  });
  const body = await response.json().catch(() => ({}));
  const plan = String(body.plan_details?.plan_type || "");
  const miles = /premium|hackathon/i.test(plan) ? 50 : 10;
  if (!response.ok) return { miles: 10, maxM2: 10 * SQUARE_METERS_PER_MILE * 0.82 };
  return { miles, maxM2: miles * SQUARE_METERS_PER_MILE * 0.82 };
}

function usableGeometry(geojson) {
  if (!geojson || typeof geojson !== "object") return null;
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") return geojson;
  if (geojson.type === "Feature") return usableGeometry(geojson.geometry);
  return null;
}

function buildPieces(place, maxM2) {
  if (!place.geometry) {
    return [{ polygon: squarePolygon(place.lat, place.lng, HALF_METERS), granularity: 60 }];
  }
  const pieces = landPieces(place.geometry, maxM2);
  return pieces.length ? pieces : [{ polygon: squarePolygon(place.lat, place.lng, HALF_METERS), granularity: 60 }];
}

function landPieces(geometry, maxM2) {
  const grid = makeGrid(geometry);
  grid.cells = insetCells(grid.cells, 1);
  const available = new Set(grid.cells.map((cell) => cellKeyOf(cell)));
  const pieces = [];
  const maxCells = Math.max(1, Math.floor(maxM2 / (grid.cell * grid.cell)));
  for (const seed of grid.cells) {
    if (!available.has(cellKeyOf(seed))) continue;
    const chunk = [];
    const queue = [seed];
    available.delete(cellKeyOf(seed));
    while (queue.length && chunk.length < maxCells) {
      const current = queue.shift();
      chunk.push(current);
      if (chunk.length >= maxCells) break;
      for (const next of gridNeighbors(current)) {
        const id = cellKeyOf(next);
        if (!available.has(id)) continue;
        if (chunk.length + queue.length >= maxCells) break;
        available.delete(id);
        queue.push(next);
      }
    }
    for (const leftover of queue) available.add(cellKeyOf(leftover));
    if (chunk.length < 8) continue;
    addChunk(pieces, chunk, grid, maxM2);
  }
  return pieces;
}

function addChunk(pieces, cells, grid, maxM2) {
  const loops = traceLoops(cells);
  const largeHole = loops.slice(1).some((loop) => Math.abs(gridLoopArea(loop)) > 20);
  const polygon = polygonFromCells(cells, grid);
  const tooLong = polygon && polygon.coordinates[0].length > 56;
  if ((!polygon || tooLong || largeHole || (polygon && polygonArea(polygon.coordinates) > maxM2)) && cells.length > 12) {
    const [left, right] = splitCells(cells);
    if (left.length >= 4 && right.length >= 4 && left.length < cells.length && right.length < cells.length) {
      addChunk(pieces, left, grid, maxM2);
      addChunk(pieces, right, grid, maxM2);
      return;
    }
  }
  if (!polygon) return;
  const area = polygonArea(polygon.coordinates);
  pieces.push({
    polygon,
    cells,
    grid,
    granularity: area > 5e6 ? 100 : 60,
  });
}

function makeGrid(geometry) {
  const box = geometryBbox(geometry);
  const midLat = (box.minLat + box.maxLat) / 2;
  const mx = 111320 * Math.cos((midLat * Math.PI) / 180);
  const my = 111320;
  const cell = 400;
  let width = Math.max((box.maxLng - box.minLng) * mx, 1);
  let height = Math.max((box.maxLat - box.minLat) * my, 1);
  let step = cell;
  let cols = Math.ceil(width / step);
  let rows = Math.ceil(height / step);
  while ((rows > 180 || cols > 180) && step < 700) {
    step += 40;
    cols = Math.ceil(width / step);
    rows = Math.ceil(height / step);
  }
  if (rows > 180 || cols > 180) {
    const error = new Error("That place is too large to map in one pass.");
    error.status = 400;
    throw error;
  }
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const west = box.minLng + (col * step) / mx;
      const east = box.minLng + (Math.min(width, (col + 1) * step)) / mx;
      const south = box.minLat + (row * step) / my;
      const north = box.minLat + (Math.min(height, (row + 1) * step)) / my;
      if (rectangleInside(geometry, west, south, east, north)) cells.push({ row, col });
    }
  }
  return { box, mx, my, cell: step, width, height, cells };
}

function gridNeighbors(cell) {
  return [
    { row: cell.row - 1, col: cell.col },
    { row: cell.row + 1, col: cell.col },
    { row: cell.row, col: cell.col - 1 },
    { row: cell.row, col: cell.col + 1 },
  ];
}

function insetCells(cells, times) {
  let next = cells;
  for (let step = 0; step < times; step += 1) {
    const inner = erodeCells(next);
    if (inner.length < 4 || inner.length === next.length) break;
    next = inner;
  }
  return next;
}

function erodeCells(cells) {
  const present = new Set(cells.map((cell) => cellKeyOf(cell)));
  const inner = cells.filter((cell) => gridNeighbors(cell).every((next) => present.has(cellKeyOf(next))));
  return inner.length >= 4 ? inner : cells;
}

function cellKeyOf(cell) {
  return `${cell.row},${cell.col}`;
}

function gridCorner(grid, col, row) {
  const x = Math.min(grid.width, col * grid.cell);
  const y = Math.min(grid.height, row * grid.cell);
  return [grid.box.minLng + x / grid.mx, grid.box.minLat + y / grid.my];
}

function polygonsFromCells(cells, grid) {
  const polygon = polygonFromCells(cells, grid);
  return polygon ? [polygon] : [];
}

function polygonFromCells(cells, grid) {
  const loops = traceLoops(cells).filter((loop) => loop.length >= 4);
  if (!loops.length) return null;
  const ring = cleanRing(loops[0].map(([col, row]) => gridCorner(grid, col, row)));
  if (!ring) return null;
  return { type: "Polygon", coordinates: [ring] };
}

function cleanRing(points) {
  const rounded = points.map(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
  const open = [];
  for (const point of rounded) {
    const previous = open[open.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    open.push(point);
  }
  if (open.length > 1 && open[0][0] === open.at(-1)[0] && open[0][1] === open.at(-1)[1]) open.pop();
  const kept = open.filter((point, index) => {
    const previous = open[(index + open.length - 1) % open.length];
    const next = open[(index + 1) % open.length];
    const turn = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
    return Math.abs(turn) > 1e-12;
  });
  if (kept.length < 3) return null;
  return orientRing([...kept, kept[0]], true);
}

function traceLoops(cells) {
  const edges = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const forward = `${x1},${y1}|${x2},${y2}`;
    const backward = `${x2},${y2}|${x1},${y1}`;
    if (edges.has(backward)) edges.delete(backward);
    else edges.set(forward, [x1, y1, x2, y2]);
  };
  for (const cell of cells) {
    addEdge(cell.col, cell.row, cell.col + 1, cell.row);
    addEdge(cell.col + 1, cell.row, cell.col + 1, cell.row + 1);
    addEdge(cell.col + 1, cell.row + 1, cell.col, cell.row + 1);
    addEdge(cell.col, cell.row + 1, cell.col, cell.row);
  }
  const from = new Map();
  for (const [x1, y1, x2, y2] of edges.values()) {
    const key = `${x1},${y1}`;
    if (!from.has(key)) from.set(key, []);
    from.get(key).push([x2, y2]);
  }
  const unused = new Set(edges.keys());
  const loops = [];
  while (unused.size) {
    const firstKey = unused.values().next().value;
    unused.delete(firstKey);
    const first = edges.get(firstKey);
    let x = first[0];
    let y = first[1];
    const start = `${x},${y}`;
    const loop = [[x, y]];
    for (let step = 0; step <= edges.size; step += 1) {
      const nexts = from.get(`${x},${y}`);
      const next = nexts?.pop();
      if (!next) break;
      unused.delete(`${x},${y}|${next[0]},${next[1]}`);
      x = next[0];
      y = next[1];
      loop.push([x, y]);
      if (`${x},${y}` === start) {
        loops.push(loop);
        break;
      }
    }
  }
  loops.sort((a, b) => Math.abs(gridLoopArea(b)) - Math.abs(gridLoopArea(a)));
  return loops;
}

function gridLoopArea(loop) {
  let sum = 0;
  for (let index = 0; index < loop.length - 1; index += 1) {
    sum += loop[index][0] * loop[index + 1][1] - loop[index + 1][0] * loop[index][1];
  }
  return sum / 2;
}

function geometryBbox(geometry) {
  const box = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  for (const part of explode(geometry)) {
    const next = ringBbox(part.coordinates[0]);
    box.minLng = Math.min(box.minLng, next.minLng);
    box.maxLng = Math.max(box.maxLng, next.maxLng);
    box.minLat = Math.min(box.minLat, next.minLat);
    box.maxLat = Math.max(box.maxLat, next.maxLat);
  }
  return box;
}

function insetPolygon(polygon, meters) {
  return {
    type: "Polygon",
    coordinates: [orientRing(insetRing(polygon.coordinates[0], meters), true)],
  };
}

function insetRing(ring, meters) {
  const open = isClosed(ring) ? ring.slice(0, -1) : ring.slice();
  const lat0 = open.reduce((sum, point) => sum + point[1], 0) / open.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 111320;
  const centerLng = open.reduce((sum, point) => sum + point[0], 0) / open.length;
  const centerLat = open.reduce((sum, point) => sum + point[1], 0) / open.length;
  const moved = open.map((point) => {
    const dx = (centerLng - point[0]) * mx;
    const dy = (centerLat - point[1]) * my;
    const distance = Math.hypot(dx, dy) || 1;
    const shift = Math.min(meters, distance * 0.4);
    return [point[0] + (dx / distance) * (shift / mx), point[1] + (dy / distance) * (shift / my)];
  });
  return [...moved, moved[0]];
}

function interiorPieces(polygon, maxM2) {
  const box = ringBbox(polygon.coordinates[0]);
  const midLat = (box.minLat + box.maxLat) / 2;
  const mx = 111320 * Math.cos((midLat * Math.PI) / 180);
  const my = 111320;
  const cell = 700;
  const width = Math.max((box.maxLng - box.minLng) * mx, 1);
  const height = Math.max((box.maxLat - box.minLat) * my, 1);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  if (rows * cols > 5000) {
    const error = new Error("That place is too large to map in one pass.");
    error.status = 400;
    throw error;
  }
  const inside = Array.from({ length: rows }, () => Array(cols).fill(false));
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const west = box.minLng + (col * cell) / mx;
      const east = box.minLng + (Math.min(width, (col + 1) * cell)) / mx;
      const south = box.minLat + (row * cell) / my;
      const north = box.minLat + (Math.min(height, (row + 1) * cell)) / my;
      inside[row][col] = rectangleInside(polygon, west, south, east, north);
    }
  }
  const used = inside.map((row) => row.map(() => false));
  const pieces = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!inside[row][col] || used[row][col]) continue;
      let spanX = 1;
      let spanY = 1;
      while (fits(inside, used, row, col, spanX + 1, spanY, cell, maxM2)) spanX += 1;
      while (fits(inside, used, row, col, spanX, spanY + 1, cell, maxM2)) spanY += 1;
      for (let y = row; y < row + spanY; y += 1) {
        for (let x = col; x < col + spanX; x += 1) used[y][x] = true;
      }
      const area = spanX * spanY * cell * cell;
      pieces.push({
        polygon: boundsPolygon(
          box.minLng + (col * cell) / mx,
          box.minLat + (row * cell) / my,
          box.minLng + ((col + spanX) * cell) / mx,
          box.minLat + ((row + spanY) * cell) / my,
        ),
        granularity: area > 5e6 ? 100 : 60,
      });
    }
  }
  return pieces;
}

function fits(inside, used, row, col, spanX, spanY, cell, maxM2) {
  if (spanX * spanY * cell * cell > maxM2) return false;
  if (row + spanY > inside.length || col + spanX > inside[0].length) return false;
  for (let y = row; y < row + spanY; y += 1) {
    for (let x = col; x < col + spanX; x += 1) {
      if (!inside[y][x] || used[y][x]) return false;
    }
  }
  return true;
}

function rectangleInside(polygon, west, south, east, north) {
  for (const lng of [west, (west + east) / 2, east]) {
    for (const lat of [south, (south + north) / 2, north]) {
      if (!geometryContains(polygon, lng, lat)) return false;
    }
  }
  return true;
}

function gridPieces(polygon, maxM2) {
  const box = ringBbox(polygon.coordinates[0]);
  const midLat = (box.minLat + box.maxLat) / 2;
  const mx = 111320 * Math.cos((midLat * Math.PI) / 180);
  const my = 111320;
  const side = Math.sqrt(maxM2);
  const width = Math.max((box.maxLng - box.minLng) * mx, 1);
  const height = Math.max((box.maxLat - box.minLat) * my, 1);
  const cols = Math.max(1, Math.ceil(width / side - 1e-6));
  const rows = Math.max(1, Math.ceil(height / side - 1e-6));
  if (rows * cols > 80) {
    const error = new Error("That place is too large to map in one pass.");
    error.status = 400;
    throw error;
  }
  const pieces = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = box.minLng + (col * side) / mx;
      const x1 = box.minLng + (Math.min(width, (col + 1) * side)) / mx;
      const y0 = box.minLat + (row * side) / my;
      const y1 = box.minLat + (Math.min(height, (row + 1) * side)) / my;
      const square = boundsPolygon(x0, y0, x1, y1);
      if (!polygonsOverlap(polygon, square)) continue;
      const area = polygonArea(square.coordinates);
      pieces.push({ polygon: square, granularity: area > 5e6 ? 100 : 60 });
    }
  }
  return pieces;
}

function boundsPolygon(west, south, east, north) {
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

function explode(geometry) {
  if (geometry.type === "Polygon") return [geometry];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  }
  return [];
}

function outlineGeometry(geometry) {
  const parts = explode(geometry).slice(0, 8).map((part) => simplifyPolygon(part, 160));
  if (parts.length === 1) return parts[0];
  return { type: "MultiPolygon", coordinates: parts.map((part) => part.coordinates) };
}

function simplifyPolygon(polygon, toleranceMeters) {
  let tolerance = toleranceMeters;
  let next = {
    type: "Polygon",
    coordinates: polygon.coordinates.map((ring) => simplifyRing(ring, tolerance)),
  };
  while (vertexCount(next) > 350 && tolerance < 800) {
    tolerance *= 1.8;
    next = {
      type: "Polygon",
      coordinates: polygon.coordinates.map((ring) => simplifyRing(ring, tolerance)),
    };
  }
  return next;
}

function vertexCount(polygon) {
  return polygon.coordinates.reduce((sum, ring) => sum + ring.length, 0);
}

function simplifyRing(ring, toleranceMeters) {
  if (!ring || ring.length < 5) return orientRing(ring, true);
  const closed = isClosed(ring);
  const open = closed ? ring.slice(0, -1) : ring.slice();
  const lat0 = open.reduce((sum, point) => sum + point[1], 0) / open.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 111320;
  const projected = open.map((point) => ({ x: point[0] * mx, y: point[1] * my, point }));
  const kept = douglasPeucker(projected, toleranceMeters).map((item) => item.point);
  if (kept.length < 3) return orientRing(ring, true);
  return orientRing([...kept, kept[0]], true);
}

function isClosed(ring) {
  if (!ring?.length) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function orientRing(ring, counterclockwise) {
  if (!ring || ring.length < 4) return ring;
  const closed = isClosed(ring) ? ring : [...ring, ring[0]];
  const positive = ringArea(closed) > 0;
  if (positive === counterclockwise) return closed;
  const open = closed.slice(0, -1).reverse();
  return [...open, open[0]];
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  let farthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointLineDistance(points[i], first, last);
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= tolerance) return [first, last];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function pointLineDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

function polygonArea(rings) {
  if (!rings?.length) return 0;
  const outer = Math.abs(ringArea(rings[0]));
  const holes = rings.slice(1).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
  return Math.max(0, outer - holes);
}

function ringArea(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 111320;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const x1 = ring[index][0] * mx;
    const y1 = ring[index][1] * my;
    const x2 = ring[index + 1][0] * mx;
    const y2 = ring[index + 1][1] * my;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function ringBbox(ring) {
  const box = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  for (const [lng, lat] of ring) {
    box.minLng = Math.min(box.minLng, lng);
    box.maxLng = Math.max(box.maxLng, lng);
    box.minLat = Math.min(box.minLat, lat);
    box.maxLat = Math.max(box.maxLat, lat);
  }
  return box;
}

function polygonsOverlap(polygon, square) {
  const center = featureCentroid({ geometry: square });
  if (geometryContains(polygon, center[0], center[1])) return true;
  for (const point of square.coordinates[0]) {
    if (geometryContains(polygon, point[0], point[1])) return true;
  }
  for (const point of polygon.coordinates[0]) {
    if (pointInRing(square.coordinates[0], point[0], point[1])) return true;
  }
  return false;
}

function geometryContains(geometry, lng, lat) {
  if (!geometry) return true;
  const parts = explode(geometry);
  return parts.some((part) => {
    if (!pointInRing(part.coordinates[0], lng, lat)) return false;
    return part.coordinates.slice(1).every((hole) => !pointInRing(hole, lng, lat));
  });
}

function pointInRing(ring, lng, lat) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const crosses = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function featureCentroid(feature) {
  const ring = feature.geometry?.type === "Polygon"
    ? feature.geometry.coordinates[0]
    : feature.geometry?.coordinates?.[0]?.[0];
  if (!ring?.length) return [0, 0];
  const count = Math.max(ring.length - 1, 1);
  const sum = ring.slice(0, count).reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
  return [sum[0] / count, sum[1] / count];
}

function cellKey(feature) {
  const [lng, lat] = featureCentroid(feature);
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function statsFromTemperatures(values) {
  if (!values.length) return { min: null, max: null, mean: null, deviation: null, count: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max, mean, deviation: Math.sqrt(variance), count: values.length };
}

function runField(record, pieces, job) {
  const seen = new Set();
  const readings = [];
  (async () => {
    for (const piece of pieces) {
      await mapPiece(piece, job, record, seen, readings);
    }
    if (!readings.length) {
      record.state = "error";
      record.error = record.error || "FortyGuard finished without a temperature grid for that place.";
      return;
    }
    record.state = "done";
    record.error = null;
  })().catch((error) => {
    console.error(error);
    if (readings.length) {
      record.state = "done";
      record.error = null;
      return;
    }
    record.state = "error";
    record.error = error.status ? error.message : "The request could not be completed.";
  });
}

async function mapPiece(piece, job, record, seen, readings) {
  try {
    const features = await loadFeatures(piece.polygon, job.place, job.date, job.time, piece.granularity);
    const fresh = [];
    for (const feature of features) {
      const key = cellKey(feature);
      if (seen.has(key)) continue;
      if (job.place.geometry && !geometryContains(job.place.geometry, ...featureCentroid(feature))) continue;
      seen.add(key);
      fresh.push(feature);
    }
    readings.push(...fresh.map((feature) => feature.properties.temperature));
    record.batches.push(fresh);
    record.done += 1;
    record.stats = statsFromTemperatures(readings);
  } catch (error) {
    const invalid = /polygon_aoi/i.test(error.message || "");
    if (invalid && piece.cells?.length > 8 && (piece.depth || 0) < 4) {
      const [left, right] = splitCells(piece.cells);
      if (left.length >= 4 && right.length >= 4) {
        record.total += 1;
        await mapPiece(childPiece(piece, left), job, record, seen, readings);
        await mapPiece(childPiece(piece, right), job, record, seen, readings);
        return;
      }
    }
    const covered = /coverage|outside supported/i.test(error.message || "");
    if (covered && piece.cells?.length > 16 && (piece.depth || 0) < 3) {
      const [left, right] = splitCells(piece.cells);
      if (left.length >= 4 && right.length >= 4) {
        record.total += 1;
        await mapPiece(childPiece(piece, left), job, record, seen, readings);
        await mapPiece(childPiece(piece, right), job, record, seen, readings);
        return;
      }
    }
    if (covered) {
      record.done += 1;
      return;
    }
    throw error;
  }
}

function childPiece(piece, cells) {
  const polygon = polygonsFromCells(cells, piece.grid)[0] || piece.polygon;
  return { ...piece, cells, polygon, depth: (piece.depth || 0) + 1 };
}

function splitCells(cells) {
  const rows = cells.map((cell) => cell.row).sort((a, b) => a - b);
  const mid = rows[Math.floor(rows.length / 2)];
  const above = cells.filter((cell) => cell.row < mid);
  const below = cells.filter((cell) => cell.row >= mid);
  if (above.length && below.length) return [above, below];
  const cols = cells.map((cell) => cell.col).sort((a, b) => a - b);
  const middle = cols[Math.floor(cols.length / 2)];
  return [cells.filter((cell) => cell.col < middle), cells.filter((cell) => cell.col >= middle)];
}

async function loadFeatures(polygon, place, date, time, granularity) {
  const heat = await heatmap(polygon, date, time, granularity);
  let features = collectFeatures(heat.readings, place);
  if (!features.length && heat.activityId) {
    const activity = await readActivity(heat.activityId);
    heat.readings.push(activity);
    features = collectFeatures([activity], place);
    if (!features.length) {
      const download = findString([activity], /map_download_url/i);
      if (download.startsWith("https://")) {
        const file = await readDownload(download);
        heat.readings.push(file);
        features = collectFeatures([file], place);
      }
    }
  }
  features = alignToCelsius(features, heat.readings);
  if (!features.length) {
    console.error("Heatmap finished without tiles", JSON.stringify(outline(heat.readings)));
    const error = new Error(heat.readError || "FortyGuard finished without a temperature grid for that piece.");
    error.status = 502;
    throw error;
  }
  return features;
}

async function heatmap(polygon, date, time, granularity) {
  return withClient(async (client) => {
    const submitted = await client.callTool(
      {
        name: "heatmap",
        arguments: {
          polygon_aoi: polygon,
          date_time: { start_date: date, start_time: time, filter_type: 1 },
          granularity,
          analytic_type: "tcm",
        },
      },
      undefined,
      { timeout: 120000 },
    );
    if (submitted?.isError) {
      const error = new Error(plainMessage(toolText(submitted)) || "FortyGuard could not map that shape.");
      error.status = 502;
      throw error;
    }
    const immediate = payloadsOf(submitted);
    const activityId = findString(immediate, /^activity_id$/i) || findString(immediate, /^heatmap_id$/i);
    if (collectFeatures(immediate, null).length) return { readings: immediate, activityId };
    if (!activityId) {
      const error = new Error("FortyGuard did not return a heatmap to read.");
      error.status = 502;
      throw error;
    }
    const deadline = Date.now() + 240000;
    let last = immediate;
    while (Date.now() < deadline) {
      await delay(5000);
      const reading = await client.callTool(
        { name: "heatmap_read", arguments: { activity_id: activityId } },
        undefined,
        { timeout: 120000 },
      );
      last = payloadsOf(reading);
      const status = activityStatus(last);
      if (collectFeatures(last, null).length || ["completed", "complete", "succeeded", "success"].includes(status)) {
        return { readings: last, activityId };
      }
      const stalled = reading?.isError || ["failed", "error", "cancelled", "canceled"].includes(status);
      if (stalled) {
        const tiles = await tilesFromActivity(activityId);
        if (tiles) return { readings: [...last, tiles], activityId };
        if (["processing", "pending", "running"].includes(status)) continue;
        return {
          readings: last,
          activityId,
          readError: plainMessage(toolText(reading)) || findString(last, /message/i) || "FortyGuard could not read that heatmap.",
        };
      }
    }
    const lateTiles = await tilesFromActivity(activityId);
    if (lateTiles) return { readings: [...last, lateTiles], activityId };
    const error = new Error("The heatmap was still running. Try that shape again.");
    error.status = 504;
    throw error;
  });
}

async function withClient(task) {
  const client = new Client({ name: "shape", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${fortyguardKey()}` } },
  });
  await client.connect(transport);
  try {
    return await task(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function tilesFromActivity(activityId) {
  if (!activityId) return null;
  try {
    const activity = await readActivity(activityId);
    const ready = collectFeatures([activity], null).length
      || findString([activity], /map_download_url/i).startsWith("https://");
    return ready ? activity : null;
  } catch {
    return null;
  }
}

async function readActivity(activityId) {
  const response = await fetch(`https://api.fortyguard.com/v1/status/${encodeURIComponent(activityId)}`, {
    headers: { "api-key": fortyguardKey(), Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const error = new Error(body.message || "FortyGuard did not return the tile grid.");
    error.status = 502;
    throw error;
  }
  return body.data || body;
}

async function readDownload(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error("FortyGuard did not return the tile grid.");
    error.status = 502;
    throw error;
  }
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    const error = new Error("FortyGuard did not return the tile grid.");
    error.status = 502;
    throw error;
  }
}

function alignToCelsius(features, readings) {
  const reference = referenceCelsius(readings);
  if (reference === null || !features.length) return features;
  const tileMean = features.reduce((sum, feature) => sum + feature.properties.temperature, 0) / features.length;
  const asFahrenheit = (reference * 9) / 5 + 32;
  const tilesAreFahrenheit = Math.abs(tileMean - asFahrenheit) + 1.5 < Math.abs(tileMean - reference);
  if (!tilesAreFahrenheit) return features;
  return features.map((feature) => ({
    ...feature,
    properties: { temperature: ((feature.properties.temperature - 32) * 5) / 9 },
  }));
}

function referenceCelsius(readings) {
  let found = null;
  for (const payload of asList(readings)) {
    walk(payload, (value, key) => {
      if (found === null && key && /mean(?:_| )?temperature(?:_| )?celsius|^mean_celsius$/i.test(key)) {
        found = usableNumber(value);
      }
    });
  }
  return found;
}

function payloadsOf(result) {
  const payloads = [];
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    payloads.push(result.structuredContent);
  }
  const text = toolText(result);
  if (text) {
    try {
      payloads.push(JSON.parse(text));
    } catch {
      payloads.push({ note: text });
    }
  }
  return payloads;
}

function collectFeatures(payloads, place) {
  const found = [];
  for (const payload of asList(payloads)) {
    walk(payload, (value) => {
      const features = featureList(value);
      if (features.length > found.length) {
        found.splice(0, found.length, ...features);
      }
    });
  }
  return found.map((feature) => {
    const temperature = cellTemperature(feature.properties);
    if (temperature === null || !feature.geometry) return null;
    return {
      type: "Feature",
      geometry: normalizeGeometry(feature.geometry, place),
      properties: { temperature },
    };
  }).filter(Boolean);
}

function featureList(value) {
  if (!value || typeof value !== "object") return [];
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) return value.features;
  if (Array.isArray(value) && value.length && value.every((item) => item && item.type === "Feature" && item.geometry)) {
    return value;
  }
  return [];
}

function cellTemperature(properties) {
  if (!properties || typeof properties !== "object") return null;
  const entries = Object.entries(properties);
  const preferred = entries.find(([key, value]) => /average[_ ]?temperature/i.test(key) && usableNumber(value) !== null);
  if (preferred) return usableNumber(preferred[1]);
  const named = entries.find(([key, value]) => /temperature/i.test(key) && !/min|max/i.test(key) && usableNumber(value) !== null);
  if (named) return usableNumber(named[1]);
  const generic = entries.find(([key, value]) => /^value$/i.test(key) && usableNumber(value) !== null);
  return generic ? usableNumber(generic[1]) : null;
}

function normalizeGeometry(geometry, place) {
  if (!geometry || !place) return geometry;
  const flip = (pair) => (Array.isArray(pair) && looksSwapped(pair, place) ? [pair[1], pair[0]] : pair);
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(flip)) };
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(flip))),
    };
  }
  return geometry;
}

function looksSwapped(pair, place) {
  const [first, second] = pair;
  if (typeof first !== "number" || typeof second !== "number") return false;
  return Math.abs(first - place.lat) + Math.abs(second - place.lng) + 0.2 < Math.abs(first - place.lng) + Math.abs(second - place.lat);
}

function collectStats(payloads, features) {
  const temperatures = features.map((feature) => feature.properties.temperature).filter((value) => value !== null);
  let deviation = null;
  for (const payload of asList(payloads)) {
    walk(payload, (value, key) => {
      if (deviation === null && key && /standard[_ ]?deviation/i.test(key)) deviation = usableNumber(value);
    });
  }
  if (!temperatures.length) return { min: null, max: null, mean: null, deviation, count: 0 };
  const sorted = [...temperatures].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    deviation,
    count: sorted.length,
  };
}

function activityStatus(payloads) {
  const statuses = [];
  for (const payload of asList(payloads)) {
    walk(payload, (value, key) => {
      if (key && /^status$/i.test(key) && typeof value === "string") statuses.push(value.trim().toLowerCase());
    });
  }
  if (statuses.some((status) => ["failed", "error", "cancelled", "canceled"].includes(status))) return "failed";
  if (statuses.some((status) => ["processing", "pending", "running"].includes(status))) return "processing";
  if (statuses.some((status) => ["completed", "complete", "succeeded", "success"].includes(status))) return "completed";
  return statuses[0] || "";
}

function findString(payloads, pattern) {
  let found = "";
  for (const payload of asList(payloads)) {
    walk(payload, (value, key) => {
      if (!found && key && pattern.test(key) && typeof value === "string" && value.trim()) found = value.trim();
    });
  }
  return found;
}

function asList(payloads) {
  return Array.isArray(payloads) ? payloads : [payloads];
}

function usableNumber(value) {
  if (typeof value === "string" && value.trim()) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value === -999) return null;
  return value;
}

function outline(node, depth = 0) {
  if (depth > 5 || node == null) return typeof node;
  if (Array.isArray(node)) return [`array(${node.length})`, node[0] ? outline(node[0], depth + 1) : "empty"];
  if (typeof node !== "object") return typeof node;
  const shape = {};
  for (const [key, value] of Object.entries(node)) shape[key] = outline(value, depth + 1);
  return shape;
}

function walk(node, visit, key = "") {
  visit(node, key);
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed.length > 1 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        walk(JSON.parse(trimmed), visit, key);
      } catch {
        return;
      }
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, key);
    return;
  }
  for (const [childKey, child] of Object.entries(node)) walk(child, visit, childKey);
}

function toolText(result) {
  return (result?.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function plainMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return parsed.message || parsed.error?.message || "FortyGuard could not map that shape.";
  } catch {
    return raw.startsWith("{") ? "FortyGuard could not map that shape." : raw;
  }
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function cleanPlaceId(value) {
  const id = String(value || "").trim();
  if (!/^(node|way|relation):\d+$/.test(id)) {
    const error = new Error("That place could not be used.");
    error.status = 400;
    throw error;
  }
  return id;
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const message = status === 500 ? "The request could not be completed." : error.message || "The request could not be completed.";
  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
}
