import * as THREE from 'three';

export const SQ3 = Math.sqrt(3);

// World layout of the hex grid: pointy-top hexes of radius 1 on the XZ plane, land centered at the origin.
// Grid row grows towards +Z, so the board reads the same way as the 2D map (row 0 far from the camera).
export function makeGrid(map) {
  const { W, cellOwner } = map;
  const unit = i => {
    const y = (i / W) | 0;
    return [SQ3 * ((i % W) + 0.5 * (y & 1)), 1.5 * y];
  };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < cellOwner.length; i++) {
    if (cellOwner[i] < 0) continue;
    const [x, z] = unit(i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const pos = i => {
    const [x, z] = unit(i);
    return [x - cx, z - cz];
  };
  const corner = (i, k) => {
    const [x, z] = pos(i);
    const a = Math.PI / 180 * (60 * k + 30);
    return [x + Math.cos(a), z + Math.sin(a)];
  };
  return {
    pos,
    corner,
    bounds: {
      minX: minX - cx - SQ3 / 2, maxX: maxX - cx + SQ3 / 2,
      minZ: minZ - cz - 1, maxZ: maxZ - cz + 1,
    },
  };
}

// Closed outlines (lists of [x, z] corners) of the region of cells where inRegion(cell) is true.
// Edges are traced with a consistent orientation, so the region is always on the same side of every loop.
export function traceLoops(map, grid, inRegion) {
  const { nb, cellOwner } = map;
  const key = (x, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
  const edges = new Map();
  for (let i = 0; i < cellOwner.length; i++) {
    if (!inRegion(i)) continue;
    for (let d = 0; d < 6; d++) {
      const n = nb[i * 6 + d];
      if (n >= 0 && inRegion(n)) continue;
      const from = grid.corner(i, (d + 5) % 6), to = grid.corner(i, d);
      edges.set(key(...from), { from, to });
    }
  }
  // On a hex grid no vertex is shared by two boundary loops, so chaining edges is unambiguous.
  const loops = [];
  while (edges.size) {
    const [startKey, first] = edges.entries().next().value;
    const loop = [];
    let k = startKey, e = first;
    while (e) {
      edges.delete(k);
      loop.push(e.from);
      k = key(...e.to);
      e = edges.get(k);
    }
    loops.push(loop);
  }
  return loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
}

export function loopArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, z1] = loop[i], [x2, z2] = loop[(i + 1) % loop.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

// Shape in the XY plane for ExtrudeGeometry; after rotateX(-PI/2) shape Y maps to world -Z.
export function shapeFromLoops(loops) {
  const toVec = loop => loop.map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(toVec(loops[0]));
  for (const hole of loops.slice(1)) shape.holes.push(new THREE.Path(toVec(hole)));
  return shape;
}

// Moves every loop `d` units into the region (mitered corners); negative `d` grows the region.
// `loops[0]` must be the outer loop.
export function insetLoops(loops, d) {
  const side = regionSide(loops);
  return loops.map(loop => offsetLoop(loop, d, side));
}

// Which side of each edge the region lies on (+1 = left); traced loops all share it.
export function regionSide(loops) {
  return Math.sign(loopArea(loops[0]));
}

export function offsetLoop(loop, d, side) {
  return loop.map((p, i) => {
    const prev = loop[(i + loop.length - 1) % loop.length], next = loop[(i + 1) % loop.length];
    const n1 = inwardNormal(prev, p, side), n2 = inwardNormal(p, next, side);
    const k = d / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k];
  });
}

function inwardNormal([x1, z1], [x2, z2], side) {
  const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
  // In (x, z) with positive shoelace area, the interior is on the side of (-dz, dx).
  return [(-dz / len) * side, (dx / len) * side];
}

// Sloped beach around the land: rings of the coastline pushed outwards and downwards.
// rings = [[distance, height, color], ...] from the land edge out into the water.
// Lakes get a narrower beach so opposite shores don't cross.
export function buildBeach(loops, rings) {
  const side = regionSide(loops);
  const positions = [], colors = [], indices = [];
  const color = new THREE.Color();
  loops.forEach((loop, li) => {
    const scale = li === 0 ? 1 : Math.min(1, Math.max(0.2, Math.sqrt(Math.abs(loopArea(loop))) * 0.25));
    const n = loop.length, base = positions.length / 3;
    for (const [dist, height, hex] of rings) {
      color.set(hex);
      for (const [x, z] of offsetLoop(loop, -dist * scale, side)) {
        positions.push(x, height, z);
        colors.push(color.r, color.g, color.b);
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < n; i++) {
        const a = base + r * n + i, b = base + r * n + (i + 1) % n;
        const c = a + n, d = b + n;
        indices.push(a, c, b, b, c, d);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
