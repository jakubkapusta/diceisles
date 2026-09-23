import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { makeGrid, traceLoops, shapeFromLoops, insetLoops, buildBeach } from './geometry.js';
import { buildShoreMask, createWater } from './water.js';
import { DiceLayer, DIE } from './dice.js';
import { Effects } from './fx.js';

const BASE_BOTTOM = -1.4;
const BASE_TOP = 0.28; // sand island surface
const TILE_H = 0.34;
const TILE_TOP = BASE_TOP + TILE_H;
const GAP = 0.07; // half of the gap between neighbouring tiles
const BEVEL = 0.06;
// Camera tilt above the horizon: low on wide screens to show the relief, steeper on portrait
// phones so the board fills the tall screen instead of being squashed into a strip.
const ELEVATION_WIDE = 40;
const ELEVATION_TALL = 58;
const SKY = '#6b9cc6';
const SAND_TOP = '#dcc592';
const SAND_SIDE = '#a98a58';
// Beach profile around the island: [distance from the land edge, height, color].
// The water (y = 0) meets it roughly halfway, where the sand turns dark and wet.
const BEACH_RINGS = [
  [0, 0.28, SAND_TOP],
  [0.15, 0.15, '#d6bd88'],
  [0.35, 0.05, '#b89c6a'],
  [0.6, -0.05, '#8f7a55'],
  [0.95, -0.3, '#6e5f45'],
];
const SUN_OFFSET = new THREE.Vector3(-9, 16, 7);

const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Board3D {
  constructor(container, { getInsets, onDiceLanded }) {
    this.container = container;
    this.getInsets = getInsets;
    this.quality = 'high';

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false; // re-rendered only when something on the board moves
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 40, 120);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.22;
    this.scene = scene;

    scene.add(new THREE.HemisphereLight('#cfe6f2', '#a88a62', 0.55));
    const sun = new THREE.DirectionalLight('#ffe6c2', 2.1);
    sun.position.copy(SUN_OFFSET);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3; // soft edges
    scene.add(sun, sun.target);
    this.sun = sun;

    this.water = createWater(SUN_OFFSET);
    scene.add(this.water.mesh);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
    this.controls = new OrbitControls(this.camera, this.canvas);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      minPolarAngle: 0.15,
      maxPolarAngle: 1.12,
      minAzimuthAngle: -0.9,
      maxAzimuthAngle: 0.9,
      screenSpacePanning: false,
    });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.clampPan());

    this.board = new THREE.Group();
    scene.add(this.board);
    this.dice = new DiceLayer(scene);
    this.dice.onLand = onDiceLanded;
    this.fx = new Effects(scene);
    this.raycaster = new THREE.Raycaster();
    this.tiles = [];
    this.view = null;
    this.map = null;
    this.activeArc = null;

    this.setupComposer();
    this.timer = new THREE.Timer();
    this.setQuality('high');
    renderer.setAnimationLoop(() => this.frame());
  }

  setupComposer() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.35, 1.35);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass()); // tone mapping + sRGB; the vignette is a CSS overlay
    this.composer = composer;
  }

  // Frees the GPU when switching to the 2D renderer.
  dispose() {
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.fx.clear();
    this.scene.traverse(o => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => m?.dispose());
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  setQuality(quality) {
    this.quality = quality;
    const high = quality === 'high';
    this.sun.castShadow = high;
    this.bloom.enabled = high;
    this.maxPixelRatio = high ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    this.pixelRatio = this.maxPixelRatio;
    this.perf = { frames: 0, time: 0, goodWindows: 0, cooldownUntil: 0 };
    this.shadowsDirty = true;
    this.resize(true);
  }

  // ---------- board construction ----------

  setMap(map, colors) {
    this.fx.clear();
    this.activeArc = null;
    for (const child of [...this.board.children]) {
      this.board.remove(child);
      child.traverse(o => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => m?.dispose());
      });
    }
    this.map = map;
    this.grid = makeGrid(map);
    this.setColors(colors);

    const land = traceLoops(map, this.grid, i => map.cellOwner[i] >= 0);
    const base = new THREE.Mesh(
      extrude(shapeFromLoops(land), BASE_TOP - BASE_BOTTOM, 0.02, 0),
      [
        new THREE.MeshStandardMaterial({ color: SAND_TOP, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: SAND_SIDE, roughness: 1 }),
      ],
    );
    base.position.y = BASE_BOTTOM;
    base.receiveShadow = true;
    const beach = new THREE.Mesh(
      buildBeach(land, BEACH_RINGS),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    );
    beach.receiveShadow = true;
    this.board.add(base, beach);

    this.tiles = map.territories.map(t => {
      const loops = traceLoops(map, this.grid, i => map.cellOwner[i] === t.id);
      const color = this.tileColors[t.owner].clone();
      const top = new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color.clone(), emissiveIntensity: 0 });
      const side = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.6), roughness: 0.7 });
      const mesh = new THREE.Mesh(extrude(shapeFromLoops(loops), TILE_H, BEVEL, -GAP - BEVEL), [top, side]);
      mesh.position.y = BASE_TOP;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.tid = t.id;

      const outlinePts = [];
      for (const loop of insetLoops(loops, GAP + 0.03)) {
        loop.forEach((p, i) => {
          const q = loop[(i + 1) % loop.length];
          outlinePts.push(p[0], TILE_TOP + 0.02, p[1], q[0], TILE_TOP + 0.02, q[1]);
        });
      }
      const outlineGeometry = new LineSegmentsGeometry().setPositions(outlinePts);
      const outlineMaterial = new LineMaterial({ color: 0xffffff, linewidth: 3, transparent: true, opacity: 0 });
      outlineMaterial.resolution.set(this.width, this.height);
      const outline = new LineSegments2(outlineGeometry, outlineMaterial);
      outline.visible = false;

      const group = new THREE.Group();
      group.add(mesh, outline);
      this.board.add(group);
      const [ax, az] = this.grid.pos(t.center);
      return {
        id: t.id, group, mesh, top, side, outline, outlineMaterial,
        anchor: new THREE.Vector3(ax, 0, az),
        color, owner: t.owner, lift: 0, glow: 0, bounceAt: -10,
      };
    });

    this.water.setMask(buildShoreMask(map, this.grid));
    this.shadowsDirty = true;
    const b = this.grid.bounds;
    const r = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 2;
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 60 });
    this.sun.shadow.camera.updateProjectionMatrix();

    this.dice.reset();
    this.dice.sync(map.territories, this.colors, this.timer.getElapsed(), 0.9);
    this.fitCamera();
  }

  // ---------- state from the game ----------

  update(view) {
    this.view = view;
    if (!this.map) return;
    this.setColors(view.players.map(p => p.color));
    this.dice.sync(this.map.territories, this.colors, this.timer.getElapsed());
  }

  // Dice use the player color as is; tiles a lighter tint so stacks stand out against their field.
  setColors(colors) {
    this.colors = colors.map(c => new THREE.Color(c));
    this.tileColors = this.colors.map(c => c.clone().lerp(new THREE.Color('#ffffff'), 0.12));
  }

  battleStart(fromId, toId, color, duration) {
    const now = this.timer.getElapsed();
    this.activeArc?.release(now);
    const from = this.stackTop(fromId), to = this.tiles[toId].anchor.clone().setY(TILE_TOP + 0.3);
    this.activeArc = this.fx.arc(from, to, new THREE.Color(color), Math.min(0.45, duration * 0.7));
  }

  battleResult(fromId, toId, won, winnerColor) {
    const now = this.timer.getElapsed();
    this.activeArc?.release(now);
    this.activeArc = null;
    this.dice.resolveBattle(fromId, toId, won, now);
    const color = new THREE.Color(winnerColor);
    const at = won ? toId : fromId;
    const pos = this.tiles[at].anchor.clone().setY(TILE_TOP + 0.25);
    this.fx.sparks(pos, color, won ? 80 : 40);
    if (won) this.fx.shockwave(this.tiles[at].anchor.clone().setY(TILE_TOP + 0.05), color);
  }

  stackTop(tid) {
    const count = this.map.territories[tid].dice;
    return this.tiles[tid].anchor.clone().setY(TILE_TOP + Math.min(count, 4) * DIE + 0.2);
  }

  // Resting position of die `i` in a stack of `count` (up to 4 per column, two columns).
  slot(tid, i, count, out) {
    const tile = this.tiles[tid];
    const column = count > 4 ? (i < 4 ? -1 : 1) : 0;
    const level = i < 4 ? i : i - 4;
    out.set(
      tile.anchor.x + column * DIE * 0.56,
      TILE_TOP + tile.group.position.y + DIE / 2 + level * DIE,
      tile.anchor.z - column * 0.06,
    );
  }

  // ---------- picking ----------

  hitTest(x, y) {
    if (!this.map) return -1;
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.dice.mesh, ...this.tiles.map(t => t.mesh)], false);
    for (const hit of hits) {
      if (hit.object === this.dice.mesh) {
        const tid = this.dice.territoryAt(hit.instanceId);
        if (tid >= 0) return tid;
      } else {
        return hit.object.userData.tid;
      }
    }
    return -1;
  }

  // ---------- camera ----------

  // Resizing the canvas clears it, so the new frame is rendered immediately; otherwise the
  // browser would show one empty frame (a visible flash).
  resize(force = false) {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.applyPixelRatio();
    for (const tile of this.tiles) tile.outlineMaterial.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.fitCamera();
    this.composer.render(0);
  }

  applyPixelRatio() {
    const { width: w, height: h } = this;
    const ratio = this.pixelRatio ?? 1;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * ratio, h * ratio);
  }

  // Dynamic resolution: drop the render resolution when frames get slow, raise it back when
  // there is headroom again. Never goes below 1 render pixel per CSS pixel.
  adaptResolution(rawDt, now) {
    const perf = this.perf;
    if (!perf || rawDt > 0.25) return; // tab was hidden or the page stalled, don't count it
    perf.frames++;
    perf.time += rawDt;
    if (perf.time < 1.5) return;
    const fps = perf.frames / perf.time;
    perf.frames = perf.time = 0;
    let next = this.pixelRatio;
    if (fps < 48 && this.pixelRatio > 1) {
      next = Math.max(1, this.pixelRatio - 0.25);
      perf.cooldownUntil = now + 10; // don't climb back right away
      perf.goodWindows = 0;
    } else if (fps > 57 && this.pixelRatio < this.maxPixelRatio && now > perf.cooldownUntil) {
      if (++perf.goodWindows >= 3) {
        next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
        perf.goodWindows = 0;
      }
    } else {
      perf.goodWindows = 0;
    }
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.applyPixelRatio();
    }
  }

  // Frames the whole board inside the area not covered by the HUD panels.
  fitCamera() {
    const { width: w, height: h, camera } = this;
    const { top, bottom } = this.getInsets();
    camera.setViewOffset(w, h, 0, (bottom - top) / 2, w, h);
    if (!this.grid) {
      camera.updateProjectionMatrix();
      return;
    }

    const b = this.grid.bounds;
    const points = [];
    for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) for (const y of [0, TILE_TOP + 4 * DIE]) {
      points.push(new THREE.Vector3(x, y, z));
    }
    const freeAspect = w / Math.max(1, h - top - bottom);
    const k = THREE.MathUtils.clamp((freeAspect - 0.6) / 0.6, 0, 1);
    const elevation = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(ELEVATION_TALL, ELEVATION_WIDE, k));
    const dir = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    const target = new THREE.Vector3(0, TILE_TOP, 0);
    const yMin = -1 + (2 * bottom) / h + 0.02, yMax = 1 - (2 * top) / h - 0.02;
    const place = d => {
      camera.position.copy(target).addScaledVector(dir, d);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      const ys = points.map(p => p.clone().project(camera));
      return {
        fits: ys.every(v => Math.abs(v.x) < 0.98 && v.y > yMin && v.y < yMax),
        mid: (Math.min(...ys.map(v => v.y)) + Math.max(...ys.map(v => v.y))) / 2,
      };
    };
    const closestFit = () => {
      let lo = 3, hi = 300;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (place(mid).fits) hi = mid; else lo = mid;
      }
      return hi;
    };
    // Perspective shrinks the far half of the board, so its middle isn't the screen middle:
    // slide the target along Z until the board is centered in the free area, then refit.
    let hi = closestFit();
    for (let i = 0; i < 3; i++) {
      const offset = place(hi).mid - (yMin + yMax) / 2;
      target.z += 0.5;
      const slope = (place(hi).mid - (offset + (yMin + yMax) / 2)) / 0.5;
      target.z -= 0.5;
      if (Math.abs(slope) < 1e-6) break;
      target.z -= offset / slope;
      hi = closestFit();
    }
    place(hi);
    this.controls.target.copy(target);
    this.controls.minDistance = hi * 0.45;
    this.controls.maxDistance = hi * 1.4;
    this.controls.update();
    this.scene.fog.near = hi * 1.2;
    this.scene.fog.far = hi * 3.2;
  }

  clampPan() {
    if (!this.grid) return;
    const b = this.grid.bounds, t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, b.minX * 0.6, b.maxX * 0.6);
    const cz = THREE.MathUtils.clamp(t.z, b.minZ * 0.6, b.maxZ * 0.6);
    if (cx !== t.x || cz !== t.z) {
      const dx = cx - t.x, dz = cz - t.z;
      t.x = cx;
      t.z = cz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  resetView() {
    this.fitCamera();
  }

  // ---------- per-frame animation ----------

  frame() {
    this.timer.update();
    const rawDt = this.timer.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const now = this.timer.getElapsed();
    this.controls.update();
    this.water.update(now);
    let moving = false;
    if (this.map && this.view) moving = this.animateTiles(dt, now);
    if (this.map) moving = this.dice.update(dt, now, (tid, i, count, out) => this.slot(tid, i, count, out)) || moving;
    this.fx.update(now);
    if (moving || this.shadowsDirty) this.renderer.shadowMap.needsUpdate = true;
    this.shadowsDirty = false;
    this.adaptResolution(rawDt, now);
    this.composer.render(dt);
  }

  // Returns true while any tile is still moving (so shadows need re-rendering).
  animateTiles(dt, now) {
    const v = this.view;
    let moving = false;
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    for (const tile of this.tiles) {
      const t = this.map.territories[tile.id];
      if (t.owner !== tile.owner) {
        tile.owner = t.owner;
        tile.bounceAt = now;
      }
      tile.color.lerp(this.tileColors[t.owner], damp(7, dt));
      tile.top.color.copy(tile.color);
      tile.top.emissive.copy(tile.color);
      tile.side.color.copy(tile.color).multiplyScalar(0.6);

      const selected = v.selected === tile.id;
      const target = v.targets.has(tile.id);
      const inBattle = v.battle && (v.battle.from === tile.id || v.battle.to === tile.id);
      const liftGoal = selected ? 0.24 : inBattle ? 0.12 : 0;
      tile.lift += (liftGoal - tile.lift) * damp(12, dt);
      const since = now - tile.bounceAt;
      const bounce = since < 0.6 ? Math.sin(since * Math.PI * 3) * 0.12 * (1 - since / 0.6) : 0;
      if (Math.abs(liftGoal - tile.lift) > 0.001 || bounce !== 0) moving = true;
      tile.group.position.y = tile.lift + bounce;

      let glowGoal = 0;
      if (selected) glowGoal = 0.22;
      else if (v.hover === tile.id) glowGoal = target ? 0.2 : 0.14;
      else if (target) glowGoal = 0.04 + 0.08 * pulse;
      if (v.flashes.has(tile.id)) glowGoal = Math.max(glowGoal, 0.22);
      tile.glow += (glowGoal - tile.glow) * damp(10, dt);
      tile.top.emissiveIntensity = tile.glow;

      let outline = null;
      // [color, HDR boost (bloom threshold is 1.35), opacity]
      if (v.battle?.from === tile.id) outline = [this.colors[t.owner], 1.8, 1];
      else if (v.battle?.to === tile.id) outline = [new THREE.Color('#ffd75e'), 1.8, 1];
      else if (selected) outline = [new THREE.Color('#ffffff'), 1.4, 1];
      else if (target) outline = [new THREE.Color('#ffffff'), 1, 0.3 + 0.5 * pulse];
      tile.outline.visible = !!outline;
      if (outline) {
        tile.outlineMaterial.color.copy(outline[0]).multiplyScalar(outline[1]);
        tile.outlineMaterial.opacity = outline[2];
      }
    }
    return moving;
  }
}

// Extruded plate lying on the XZ plane, spanning y = 0..height. `inset` < 0 shrinks the outline.
function extrude(shape, height, bevel, inset) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, height - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: inset,
    bevelSegments: 3,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bevel, 0);
  return geometry;
}
