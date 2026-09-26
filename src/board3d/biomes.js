import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Biome look for each player color. Every biome keeps the player's hue dominant, so ownership still
// reads at a glance, while the ground stays different enough in tone for same-colored dice to stand out.
export const BIOME_BY_COLOR = {
  '#3fb68b': 'meadow', // green
  '#f2c14e': 'desert', // yellow
  '#4aa3df': 'glacier', // blue
  '#e07fc4': 'sakura', // pink
  '#f28f3b': 'canyon', // orange
  '#a06cd5': 'crystal', // purple
  '#9acd32': 'swamp', // lime
  '#e5566f': 'lava', // red
};

// Textures are generated on the CPU once per session; phones get half the resolution
// (4x less work, and the difference isn't visible on a small screen).
const TEX_SIZE = window.matchMedia('(pointer: coarse)').matches ? 256 : 512;
export const TEXTURE_WORLD_SIZE = 6; // world units covered by one texture tile

// ---------- tileable noise ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise on a lattice that wraps every `period` cells, so textures repeat without seams.
function periodicNoise(period, seed) {
  const r = rng(seed);
  const grid = Float32Array.from({ length: period * period }, r);
  const wrap = i => ((i % period) + period) % period;
  return (u, v) => { // u, v in [0, 1)
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = wrap(ix), x1 = x0 + 1 === period ? 0 : x0 + 1;
    const y0 = wrap(iy) * period, y1 = (y0 + period) % (period * period);
    const a = grid[y0 + x0], b = grid[y0 + x1], c = grid[y1 + x0], d = grid[y1 + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function fbm(seed, basePeriod, octaves = 4) {
  const layers = Array.from({ length: octaves }, (_, i) => periodicNoise(basePeriod << i, seed + i * 101));
  return (u, v) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (const n of layers) { sum += n(u, v) * amp; norm += amp; amp *= 0.5; }
    return sum / norm;
  };
}

// Tileable Voronoi: `edge` is ~0 on the border between two plates, `id` identifies the plate.
// One point per grid cell, so the two nearest points always lie within the surrounding 5x5 cells
// (needs cells >= 5, otherwise the window would visit a point twice).
function voronoi(cells, seed) {
  const r = rng(seed);
  const px = new Float64Array(cells * cells), py = new Float64Array(cells * cells), ids = new Float64Array(cells * cells);
  for (let k = 0; k < cells * cells; k++) {
    const gx = k % cells, gy = (k / cells) | 0;
    px[k] = (gx + r()) / cells;
    py[k] = (gy + r()) / cells;
    ids[k] = r();
  }
  const wrap = i => (i + cells) % cells;
  return (u, v) => {
    const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
    let d1 = Infinity, d2 = Infinity, id = 0;
    for (let oy = -2; oy <= 2; oy++) {
      const row = wrap(cy + oy) * cells;
      for (let ox = -2; ox <= 2; ox++) {
        const k = row + wrap(cx + ox);
        let dx = Math.abs(u - px[k]), dy = Math.abs(v - py[k]);
        dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy); // wrap around → tileable
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) { d2 = d1; d1 = d; id = ids[k]; } else if (d < d2) d2 = d;
      }
    }
    return { edge: (d2 - d1) * cells, id };
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.min(1, Math.max(0, t));
const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Paints a texture pixel by pixel; paint(u, v) returns [r, g, b].
function paintTexture(paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g, b] = paint(x / TEX_SIZE, y / TEX_SIZE);
      const i = (y * TEX_SIZE + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function toTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / TEXTURE_WORLD_SIZE, 1 / TEXTURE_WORLD_SIZE);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Scatters small round dots (flowers, pebbles, petals) with wrap-around so they tile too.
function sprinkle(canvas, seed, count, colors, radius) {
  const ctx = canvas.getContext('2d'), r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * TEX_SIZE, y = r() * TEX_SIZE, rad = radius * (TEX_SIZE / 512) * (0.6 + r() * 0.8);
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    for (const dx of [-TEX_SIZE, 0, TEX_SIZE]) for (const dy of [-TEX_SIZE, 0, TEX_SIZE]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- ground textures ----------

function desertTextures() {
  const big = fbm(11, 3), warp = fbm(23, 4), grain = periodicNoise(96, 7);
  const dark = hexRgb('#d2a24e'), light = hexRgb('#f1d68f');
  const canvas = paintTexture((u, v) => {
    // Wind ripples: whole number of waves across the tile, bent by noise so they look like dunes.
    const ripple = Math.sin(2 * Math.PI * (v * 14 + u * 3 + warp(u, v) * 3));
    return mixRgb(dark, light, clamp01(0.35 + (big(u, v) - 0.5) * 0.9 + ripple * 0.12 + (grain(u, v) - 0.5) * 0.12));
  });
  sprinkle(canvas, 5, 60, ['#b48a45', '#c79a55', '#9c7a4a'], 2.2);
  return { map: toTexture(canvas) };
}

function meadowTextures() {
  const patches = fbm(31, 3), blades = periodicNoise(128, 41), blades2 = periodicNoise(64, 43);
  const dark = hexRgb('#2f7d45'), light = hexRgb('#79c86d');
  const canvas = paintTexture((u, v) => {
    const t = 0.45 + (patches(u, v) - 0.5) * 1.1 + (blades(u, v) - 0.5) * 0.35 + (blades2(u, v) - 0.5) * 0.2;
    return mixRgb(dark, light, clamp01(t));
  });
  sprinkle(canvas, 9, 140, ['#fff6e0', '#ffe066', '#ff9ec7', '#f7f7ff'], 2.3);
  return { map: toTexture(canvas) };
}

// Warm red crust split by glowing cracks; some stretches have cooled over so not every edge glows.
function lavaTextures() {
  const plates = voronoi(11, 77), rock = fbm(61, 4), wobble = fbm(67, 6), cool = fbm(71, 2);
  const rockDark = hexRgb('#7a2c2c'), rockLight = hexRgb('#b4514a');
  const hot = hexRgb('#ffc05a'), warm = hexRgb('#f0542a');
  const glow = paintTexture((u, v) => {
    const edge = plates(u, v).edge + (wobble(u, v) - 0.5) * 0.3;
    const crack = Math.max(0, 1 - edge / 0.1) * clamp01((cool(u, v) - 0.42) * 3);
    return mixRgb([0, 0, 0], mixRgb(warm, hot, crack * crack), clamp01(crack * 1.6));
  });
  const glowData = glow.getContext('2d').getImageData(0, 0, TEX_SIZE, TEX_SIZE).data;
  const color = paintTexture((u, v) => {
    const i = (Math.floor(v * TEX_SIZE) * TEX_SIZE + Math.floor(u * TEX_SIZE)) * 4;
    const base = mixRgb(rockDark, rockLight, rock(u, v));
    return mixRgb(base, [glowData[i], glowData[i + 1], glowData[i + 2]], clamp01(glowData[i] / 255 * 1.2));
  });
  return { map: toTexture(color), emissiveMap: toTexture(glow), emissive: '#ff5a1f', emissiveIntensity: 0.8 };
}

// Violet stone broken into flat crystal facets, each shaded a little differently, with glints.
function crystalTextures() {
  const facets = voronoi(9, 83), shade = fbm(89, 3);
  const dark = hexRgb('#40296e'), light = hexRgb('#7657b0'), seam = hexRgb('#2a1a4c');
  const canvas = paintTexture((u, v) => {
    const { edge, id } = facets(u, v);
    const base = mixRgb(dark, light, clamp01(0.25 + id * 0.55 + (shade(u, v) - 0.5) * 0.4));
    return mixRgb(base, seam, clamp01(1 - edge / 0.06) * 0.7);
  });
  sprinkle(canvas, 13, 90, ['#d8c4ff', '#b89cf0', '#f2eaff'], 1.6);
  return { map: toTexture(canvas) };
}

// Sandstone with soft, wavy strata in close terracotta tones, seen from above like eroded layers.
function canyonTextures() {
  const warp = fbm(97, 3), grain = periodicNoise(80, 101), big = fbm(103, 2);
  const bands = ['#d47a3e', '#e08d4e', '#e99c5e', '#dc8446', '#cf7238'].map(hexRgb);
  const canvas = paintTexture((u, v) => {
    // Smooth blend between neighbouring layers instead of hard stripes.
    const s = (((v * 3 + u + warp(u, v) * 1.8) % 1) + 1) % 1 * bands.length;
    const layer = Math.floor(s), f = s - layer;
    const base = mixRgb(bands[layer], bands[(layer + 1) % bands.length], f * f * (3 - 2 * f));
    return mixRgb(base, [255, 235, 200], clamp01((grain(u, v) - 0.5) * 0.3 + (big(u, v) - 0.5) * 0.35));
  });
  sprinkle(canvas, 17, 50, ['#8f4520', '#a85a30'], 2);
  return { map: toTexture(canvas) };
}

// Blue glacier ice in plates with pale cracks and a dusting of frost.
function glacierTextures() {
  const plates = voronoi(8, 107), frost = fbm(109, 5), shade = fbm(113, 2);
  const deep = hexRgb('#5f9fd8'), pale = hexRgb('#b9dcf7'), crack = hexRgb('#eaf6ff');
  const canvas = paintTexture((u, v) => {
    const { edge, id } = plates(u, v);
    const base = mixRgb(deep, pale, clamp01(0.3 + id * 0.3 + (shade(u, v) - 0.5) * 0.6 + (frost(u, v) - 0.5) * 0.4));
    return mixRgb(base, crack, clamp01(1 - edge / 0.05) * 0.8);
  });
  sprinkle(canvas, 19, 70, ['#ffffff', '#e2f1ff'], 1.8);
  return { map: toTexture(canvas) };
}

// Yellow-green moss with dark puddles and muddy patches.
function swampTextures() {
  const puddles = fbm(127, 3), moss = fbm(131, 6), mud = fbm(137, 4);
  const dark = hexRgb('#5f7d22'), light = hexRgb('#9cb444'), water = hexRgb('#2f4726'), mudRgb = hexRgb('#6d5a2e');
  const canvas = paintTexture((u, v) => {
    let c = mixRgb(dark, light, clamp01(0.45 + (moss(u, v) - 0.5) * 1.2));
    c = mixRgb(c, mudRgb, clamp01((mud(u, v) - 0.62) * 5) * 0.6);
    return mixRgb(c, water, clamp01((0.36 - puddles(u, v)) * 12));
  });
  sprinkle(canvas, 23, 60, ['#d8ec70', '#e8f58a'], 1.6);
  return { map: toTexture(canvas) };
}

// A carpet of fallen cherry petals over grass, pink dominant.
function sakuraTextures() {
  const carpet = fbm(139, 3), fine = periodicNoise(110, 149);
  const deep = hexRgb('#eeaad2'), pale = hexRgb('#fde6f2'), grass = hexRgb('#9cc77e');
  const canvas = paintTexture((u, v) => {
    const t = carpet(u, v);
    const petals = mixRgb(deep, pale, clamp01(0.4 + (t - 0.5) * 1.2 + (fine(u, v) - 0.5) * 0.4));
    return mixRgb(petals, grass, clamp01((0.3 - t) * 6) * 0.8);
  });
  sprinkle(canvas, 29, 160, ['#ffffff', '#ffe3f2', '#f59ccb'], 2.2);
  return { map: toTexture(canvas) };
}

const TEXTURE_BUILDERS = {
  desert: desertTextures, meadow: meadowTextures, lava: lavaTextures, crystal: crystalTextures,
  canyon: canyonTextures, glacier: glacierTextures, swamp: swampTextures, sakura: sakuraTextures,
};
const textureCache = new Map();

// Textures are generated once per biome, the first time a board needs them.
export function biomeTextures(biome) {
  if (!textureCache.has(biome)) textureCache.set(biome, TEXTURE_BUILDERS[biome]());
  return textureCache.get(biome);
}

// ---------- props (small low-poly decorations) ----------

const pick = (r, list) => list[Math.floor(r() * list.length)];

// Each prop returns [{ geometry, color, glow? }], positioned with its base at y = 0.
// `glow` parts are drawn unlit in a bright color, so the bloom pass makes them shine.
const PROPS = {
  cactus: r => {
    const h = 0.26 + r() * 0.14;
    const parts = [{ geometry: new THREE.CylinderGeometry(0.05, 0.06, h, 7).translate(0, h / 2, 0), color: '#4f8a3a' }];
    for (const side of [-1, 1]) {
      if (r() < 0.35) continue;
      const y = h * (0.4 + r() * 0.3);
      parts.push({ geometry: new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6).rotateZ(Math.PI / 2).translate(side * 0.08, y, 0), color: '#4f8a3a' });
      parts.push({ geometry: new THREE.CylinderGeometry(0.035, 0.035, 0.12, 6).translate(side * 0.12, y + 0.06, 0), color: '#5a9642' });
    }
    return parts;
  },
  sandRock: r => [{ geometry: new THREE.DodecahedronGeometry(0.07 + r() * 0.05, 0).scale(1.3, 0.6, 1).translate(0, 0.03, 0), color: '#b88d52' }],
  tree: r => {
    const h = 0.13 + r() * 0.06;
    return [
      { geometry: new THREE.CylinderGeometry(0.025, 0.035, h, 6).translate(0, h / 2, 0), color: '#7a5230' },
      { geometry: new THREE.IcosahedronGeometry(0.13 + r() * 0.04, 0).translate(0, h + 0.1, 0), color: r() < 0.5 ? '#3e8f3e' : '#4a9d45' },
      { geometry: new THREE.IcosahedronGeometry(0.09, 0).translate(0.05, h + 0.2, 0.02), color: '#5cae52' },
    ];
  },
  bush: r => [{ geometry: new THREE.IcosahedronGeometry(0.07 + r() * 0.03, 0).scale(1.2, 0.8, 1.2).translate(0, 0.05, 0), color: '#468f3f' }],
  flowers: r => Array.from({ length: 4 }, () => ({
    geometry: new THREE.IcosahedronGeometry(0.025, 0).translate((r() - 0.5) * 0.18, 0.03, (r() - 0.5) * 0.18),
    color: pick(r, ['#fff6e0', '#ffd23f', '#ff8fbf', '#b98cff']),
  })),
  basalt: r => [{ geometry: new THREE.DodecahedronGeometry(0.08 + r() * 0.06, 0).scale(1, 0.8 + r() * 0.5, 1).translate(0, 0.05, 0), color: '#4a2a2a' }],
  vent: r => {
    const h = 0.2 + r() * 0.12;
    return [
      { geometry: new THREE.ConeGeometry(0.09, h, 6).translate(0, h / 2, 0), color: '#5a3232' },
      { geometry: new THREE.IcosahedronGeometry(0.035, 0).translate(0, h - 0.01, 0), color: '#ff7a2a', glow: '#ff7a2a' },
    ];
  },
  crystals: r => Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => {
    const h = 0.14 + r() * 0.2, lean = (r() - 0.5) * 0.6;
    const color = pick(r, ['#c9a3ff', '#a77ce8', '#e2c6ff', '#9a6be0']);
    return {
      geometry: new THREE.OctahedronGeometry(0.05, 0).scale(1, h / 0.05 / 2, 1)
        .translate(0, h / 2, 0).rotateZ(lean).rotateY(r() * Math.PI * 2)
        .translate((r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12),
      color,
      glow: i === 0 && r() < 0.4 ? '#d6a8ff' : undefined,
    };
  }),
  violetRock: r => [{ geometry: new THREE.DodecahedronGeometry(0.07 + r() * 0.04, 0).scale(1.2, 0.7, 1).translate(0, 0.04, 0), color: '#5d3d8a' }],
  mesa: r => {
    const w = 0.13 + r() * 0.06;
    return [
      { geometry: new THREE.CylinderGeometry(w, w * 1.2, 0.1, 7).translate(0, 0.05, 0), color: '#b8572a' },
      { geometry: new THREE.CylinderGeometry(w * 0.85, w, 0.09, 7).translate(0, 0.145, 0), color: '#e08a45' },
      { geometry: new THREE.CylinderGeometry(w * 0.8, w * 0.85, 0.04, 7).translate(0, 0.21, 0), color: '#f0b070' },
    ];
  },
  hoodoo: r => {
    const h = 0.18 + r() * 0.12;
    return [
      { geometry: new THREE.CylinderGeometry(0.035, 0.055, h, 6).translate(0, h / 2, 0), color: '#d4743a' },
      { geometry: new THREE.DodecahedronGeometry(0.06, 0).scale(1.2, 0.6, 1.2).translate(0, h + 0.02, 0), color: '#8f4520' },
    ];
  },
  iceSpike: r => Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
    const h = 0.14 + r() * 0.2;
    return {
      geometry: new THREE.ConeGeometry(0.04 + r() * 0.02, h, 5).translate(0, h / 2, 0)
        .rotateZ((r() - 0.5) * 0.4).translate((r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12),
      color: pick(r, ['#bfe6ff', '#d9f1ff', '#a5d6fb']),
    };
  }),
  snowyPine: r => {
    const h = 0.26 + r() * 0.1;
    return [
      { geometry: new THREE.CylinderGeometry(0.018, 0.024, 0.06, 5).translate(0, 0.03, 0), color: '#6b4a32' },
      { geometry: new THREE.ConeGeometry(0.1, h, 7).translate(0, 0.05 + h / 2, 0), color: '#2f5d4d' },
      { geometry: new THREE.ConeGeometry(0.055, h * 0.4, 7).translate(0, 0.05 + h * 0.8, 0), color: '#f4fbff' },
    ];
  },
  snowMound: r => [{ geometry: new THREE.IcosahedronGeometry(0.07 + r() * 0.03, 1).scale(1.4, 0.5, 1.2).translate(0, 0.02, 0), color: '#eef7ff' }],
  reeds: r => Array.from({ length: 4 + Math.floor(r() * 3) }, () => {
    const h = 0.14 + r() * 0.12, x = (r() - 0.5) * 0.12, z = (r() - 0.5) * 0.12;
    return [
      { geometry: new THREE.CylinderGeometry(0.007, 0.01, h, 4).translate(x, h / 2, z), color: '#6f8f2a' },
      { geometry: new THREE.CylinderGeometry(0.016, 0.016, 0.05, 5).translate(x, h - 0.03, z), color: '#6b4424' },
    ];
  }).flat(),
  deadTree: r => {
    const h = 0.22 + r() * 0.1;
    return [
      { geometry: new THREE.CylinderGeometry(0.018, 0.03, h, 5).translate(0, h / 2, 0), color: '#5e5242' },
      { geometry: new THREE.CylinderGeometry(0.01, 0.014, 0.12, 4).rotateZ(0.8).translate(0.04, h * 0.7, 0), color: '#5e5242' },
      { geometry: new THREE.CylinderGeometry(0.009, 0.012, 0.1, 4).rotateZ(-0.9).translate(-0.035, h * 0.55, 0.01), color: '#5e5242' },
    ];
  },
  mushrooms: r => Array.from({ length: 2 + Math.floor(r() * 2) }, () => {
    const x = (r() - 0.5) * 0.12, z = (r() - 0.5) * 0.12, h = 0.04 + r() * 0.04;
    const glowing = r() < 0.35;
    return [
      { geometry: new THREE.CylinderGeometry(0.01, 0.013, h, 5).translate(x, h / 2, z), color: '#efe6c8' },
      {
        geometry: new THREE.SphereGeometry(0.03, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, h, z),
        color: glowing ? '#c8ff5a' : '#b5462e',
        glow: glowing ? '#c8ff5a' : undefined,
      },
    ];
  }).flat(),
  sakuraTree: r => {
    const h = 0.14 + r() * 0.05;
    return [
      { geometry: new THREE.CylinderGeometry(0.022, 0.032, h, 6).translate(0, h / 2, 0), color: '#6b4430' },
      { geometry: new THREE.IcosahedronGeometry(0.14 + r() * 0.03, 0).translate(0, h + 0.1, 0), color: '#f29ac9' },
      { geometry: new THREE.IcosahedronGeometry(0.1, 0).translate(0.07, h + 0.16, -0.03), color: '#ffc3e1' },
      { geometry: new THREE.IcosahedronGeometry(0.08, 0).translate(-0.07, h + 0.06, 0.04), color: '#ea86bd' },
    ];
  },
  pinkBush: r => [{ geometry: new THREE.IcosahedronGeometry(0.07 + r() * 0.03, 0).scale(1.2, 0.85, 1.2).translate(0, 0.05, 0), color: '#f3a6d0' }],
  lantern: () => [
    { geometry: new THREE.BoxGeometry(0.07, 0.03, 0.07).translate(0, 0.015, 0), color: '#9d9aa3' },
    { geometry: new THREE.CylinderGeometry(0.018, 0.018, 0.1, 6).translate(0, 0.08, 0), color: '#aeabb4' },
    { geometry: new THREE.BoxGeometry(0.06, 0.05, 0.06).translate(0, 0.155, 0), color: '#fff1c9', glow: '#ffe7a8' },
    { geometry: new THREE.ConeGeometry(0.07, 0.05, 4).rotateY(Math.PI / 4).translate(0, 0.205, 0), color: '#8f8c96' },
  ],
};

// Prop mix per biome: [prop, weight].
const BIOME_PROPS = {
  desert: [['cactus', 3], ['sandRock', 2]],
  meadow: [['tree', 3], ['bush', 2], ['flowers', 3]],
  lava: [['basalt', 3], ['vent', 2]],
  crystal: [['crystals', 4], ['violetRock', 2]],
  canyon: [['mesa', 2], ['hoodoo', 3]],
  glacier: [['iceSpike', 3], ['snowyPine', 2], ['snowMound', 2]],
  swamp: [['reeds', 3], ['deadTree', 2], ['mushrooms', 2]],
  sakura: [['sakuraTree', 4], ['pinkBush', 2], ['lantern', 1]],
};

const PROP_SCALE = 1.8; // props are modelled small; this sizes them for the board

// Shared by every field; marked so board cleanup doesn't dispose them.
const propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
propMaterial.userData.shared = true;
const glowMaterials = new Map();
function glowMaterial(hex) {
  if (!glowMaterials.has(hex)) {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(2.5) });
    material.userData.shared = true;
    glowMaterials.set(hex, material);
  }
  return glowMaterials.get(hex);
}

function pickWeighted(list, r) {
  let x = r() * list.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of list) if ((x -= w) < 0) return item;
  return list[0][0];
}

function withColor(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

// Decorations for one field, relative to the field's surface (y = 0) and away from the dice stack.
// `spots` are [x, z] cell centers of the field; `anchor` is where the dice stand.
export function buildProps(biome, spots, anchor, seed) {
  const r = rng(seed);
  const solid = [], glowing = new Map();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const [cx, cz] of spots) {
    const count = r() < 0.75 ? 1 : 2;
    for (let k = 0; k < count; k++) {
      const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * 0.5; // stays inside the hex, clear of the gap
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      if (Math.hypot(x - anchor.x, z - anchor.z) < 1.35) continue; // keep the dice stack clear
      const size = PROP_SCALE * (0.85 + r() * 0.3);
      m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, r() * Math.PI * 2), new THREE.Vector3(size, size, size));
      for (const part of PROPS[pickWeighted(BIOME_PROPS[biome], r)](r)) {
        const geometry = withColor(part.geometry.applyMatrix4(m), part.color);
        if (part.glow) {
          if (!glowing.has(part.glow)) glowing.set(part.glow, []);
          glowing.get(part.glow).push(geometry);
        } else {
          solid.push(geometry);
        }
      }
    }
  }
  const group = new THREE.Group();
  if (solid.length) {
    const mesh = new THREE.Mesh(mergeGeometries(solid), propMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (const [hex, parts] of glowing) group.add(new THREE.Mesh(mergeGeometries(parts), glowMaterial(hex)));
  [...solid, ...[...glowing.values()].flat()].forEach(g => g.dispose());
  return group;
}

// Materials shared by all props are kept alive; only the merged geometries belong to a field.
export function disposeProps(group) {
  group.traverse(o => o.geometry?.dispose());
}
