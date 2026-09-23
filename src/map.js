
// Pointy-top hex grid, "odd-r" offset layout.
// Direction order: E, SE, SW, W, NW, NE.
export const HEX_DIRS = [
  [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]], // even rows
  [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]],   // odd rows
];

export const rndInt = n => Math.floor(Math.random() * n);
export const pickRandom = arr => arr[rndInt(arr.length)];

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rndInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildNeighbors(W, H) {
  const nb = new Int32Array(W * H * 6).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dirs = HEX_DIRS[y & 1];
      for (let d = 0; d < 6; d++) {
        const nx = x + dirs[d][0], ny = y + dirs[d][1];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) nb[(y * W + x) * 6 + d] = ny * W + nx;
      }
    }
  }
  return nb;
}

// `aspect` = width / height of the screen area the map should fill (landscape > 1, portrait < 1).
export function generateMap(count, aspect = 1.45) {
  for (let i = 0; i < 100; i++) {
    const map = tryGenerateMap(count, aspect);
    if (map) return map;
  }
  throw new Error('Nie udało się wygenerować mapy');
}

function tryGenerateMap(count, aspect) {
  // Grid roughly 2.4x bigger than the land we need, so the landmass can take an irregular shape.
  // Hex columns are sqrt(3) wide and rows 1.5 tall, so a W/H cell ratio of 0.866 * aspect matches the screen.
  const cellsWanted = count * 8 * 2.4;
  const cellRatio = 0.866 * Math.min(1.8, Math.max(0.55, aspect));
  const H = Math.max(8, Math.round(Math.sqrt(cellsWanted / cellRatio)));
  const W = Math.max(8, Math.round(cellsWanted / H));
  const size = W * H;
  const nb = buildNeighbors(W, H);
  const cellOwner = new Int16Array(size).fill(-1);
  const blocked = new Uint8Array(size);
  const territories = [];

  // Normalized distance from grid center — used to keep the landmass shaped like the grid.
  const spread = i => {
    const dx = (i % W) / W - 0.5, dy = ((i / W) | 0) / H - 0.5;
    return dx * dx + dy * dy;
  };

  let failures = 0;
  while (territories.length < count) {
    let seed;
    if (!territories.length) {
      seed = ((H / 2) | 0) * W + ((W / 2) | 0);
    } else {
      // New territories always start next to existing land, so the map is one connected landmass.
      const frontier = [];
      for (let i = 0; i < size; i++) {
        if (cellOwner[i] >= 0 || blocked[i]) continue;
        for (let d = 0; d < 6; d++) {
          const n = nb[i * 6 + d];
          if (n >= 0 && cellOwner[n] >= 0) { frontier.push(i); break; }
        }
      }
      if (!frontier.length) return null;
      const a = pickRandom(frontier), b = pickRandom(frontier);
      seed = spread(a) <= spread(b) ? a : b;
    }

    const id = territories.length;
    const target = 6 + rndInt(5);
    const cells = [seed];
    cellOwner[seed] = id;
    while (cells.length < target) {
      // Grow into the free cell touching the most of our own cells (plus noise) — keeps shapes compact.
      let best = -1, bestScore = -Infinity;
      for (const c of cells) {
        for (let d = 0; d < 6; d++) {
          const n = nb[c * 6 + d];
          if (n < 0 || cellOwner[n] >= 0) continue;
          let score = Math.random() * 1.5;
          for (let e = 0; e < 6; e++) {
            const m = nb[n * 6 + e];
            if (m >= 0 && cellOwner[m] === id) score++;
          }
          if (score > bestScore) { bestScore = score; best = n; }
        }
      }
      if (best < 0) break;
      cellOwner[best] = id;
      cells.push(best);
    }

    if (cells.length < 4) {
      for (const c of cells) cellOwner[c] = -1;
      blocked[seed] = 1;
      if (++failures > 300) return null;
      continue;
    }
    territories.push({ id, cells });
  }

  // Fill tiny holes and narrow bays between territories.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < size; i++) {
      if (cellOwner[i] >= 0) continue;
      let filled = 0, smallest = -1;
      for (let d = 0; d < 6; d++) {
        const n = nb[i * 6 + d];
        const t = n < 0 ? -1 : cellOwner[n];
        if (t < 0) continue;
        filled++;
        if (smallest < 0 || territories[t].cells.length < territories[smallest].cells.length) smallest = t;
      }
      if (filled >= 5) {
        cellOwner[i] = smallest;
        territories[smallest].cells.push(i);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const adj = territories.map(() => new Set());
  for (let i = 0; i < size; i++) {
    const t = cellOwner[i];
    if (t < 0) continue;
    for (let d = 0; d < 6; d++) {
      const n = nb[i * 6 + d];
      if (n >= 0 && cellOwner[n] >= 0 && cellOwner[n] !== t) adj[t].add(cellOwner[n]);
    }
  }

  // Dice stack anchor: the cell nearest to the centroid, preferring cells fully inside the territory.
  const unit = i => { const y = (i / W) | 0; return [(i % W) + 0.5 * (y & 1), y * 0.866]; };
  const isInterior = (i, t) => {
    for (let d = 0; d < 6; d++) {
      const n = nb[i * 6 + d];
      if (n < 0 || cellOwner[n] !== t) return false;
    }
    return true;
  };

  return {
    W, H, nb, cellOwner,
    territories: territories.map(t => {
      let cx = 0, cy = 0;
      for (const c of t.cells) { const [x, y] = unit(c); cx += x; cy += y; }
      cx /= t.cells.length; cy /= t.cells.length;
      let center = t.cells[0], bestD = Infinity;
      for (const c of t.cells) {
        const [x, y] = unit(c);
        const dist = (x - cx) ** 2 + (y - cy) ** 2 + (isInterior(c, t.id) ? 0 : 0.6);
        if (dist < bestD) { bestD = dist; center = c; }
      }
      return { id: t.id, cells: t.cells, adj: [...adj[t.id]], center, owner: -1, dice: 0 };
    }),
  };
}

// Size of the biggest connected group of territories owned by `pid` — that's the per-turn dice income.
export function largestGroup(map, pid) {
  const T = map.territories;
  const seen = new Uint8Array(T.length);
  let best = 0;
  for (const t of T) {
    if (t.owner !== pid || seen[t.id]) continue;
    let groupSize = 0;
    const stack = [t.id];
    seen[t.id] = 1;
    while (stack.length) {
      const id = stack.pop();
      groupSize++;
      for (const n of T[id].adj) {
        if (!seen[n] && T[n].owner === pid) { seen[n] = 1; stack.push(n); }
      }
    }
    best = Math.max(best, groupSize);
  }
  return best;
}
