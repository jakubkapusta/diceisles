// Flat 2D board on a canvas. Same interface as Board3D, so the game can swap renderers at runtime.

const SQ3 = Math.sqrt(3);
const DICE_HEADROOM = 1.5; // extra space above the top row (in hex radii) for dice stacks
const BORDER_COLOR = '#0b1220';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex, other, t) {
  const a = hexToRgb(hex), b = hexToRgb(other);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

export class Board2D {
  constructor(container, { getInsets }) {
    this.container = container;
    this.getInsets = getInsets;
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.map = null;
    this.used = [];
    this.view = null;
    this.faces = new Map();
    this.resize(true);
  }

  dispose() {
    this.canvas.remove();
  }

  // Nothing to tune in 2D; kept for interface parity with Board3D.
  setQuality() {}
  battleStart() {}
  battleResult() {}

  resetView() {
    this.layout();
    this.draw();
  }

  setMap(map) {
    this.map = map;
    this.used = [];
    for (let i = 0; i < map.cellOwner.length; i++) if (map.cellOwner[i] >= 0) this.used.push(i);
    this.layout();
    this.draw();
  }

  update(view) {
    this.view = view;
    this.draw();
  }

  resize(force = false) {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.layout();
    this.draw();
  }

  // Fits the map into the screen area not covered by the HUD panels.
  layout() {
    if (!this.map) return;
    const { top, bottom } = this.getInsets();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of this.used) {
      const [x, y] = this.unit(i);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const left = minX - SQ3 / 2, right = maxX + SQ3 / 2;
    const up = minY - 1 - DICE_HEADROOM, down = maxY + 1;
    const pad = 12;
    const availH = Math.max(50, this.height - top - bottom);
    this.s = Math.max(4, Math.min((this.width - 2 * pad) / (right - left), availH / (down - up)));
    this.ox = (this.width - (right - left) * this.s) / 2 - left * this.s;
    this.oy = top + (availH - (down - up) * this.s) / 2 - up * this.s;
  }

  unit(i) {
    const W = this.map.W, y = (i / W) | 0;
    return [SQ3 * ((i % W) + 0.5 * (y & 1)), 1.5 * y];
  }

  center(i) {
    const [x, y] = this.unit(i);
    return [this.ox + x * this.s, this.oy + y * this.s];
  }

  hitTest(px, py) {
    if (!this.map) return -1;
    let best = -1, bestD = Infinity;
    for (const i of this.used) {
      const [cx, cy] = this.center(i);
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 && bestD <= (this.s * 0.95) ** 2 ? this.map.cellOwner[best] : -1;
  }

  corner(cx, cy, k, r) {
    const a = Math.PI / 180 * (60 * k + 30);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  hexPath(cx, cy, r) {
    const ctx = this.ctx;
    for (let k = 0; k < 6; k++) {
      const [x, y] = this.corner(cx, cy, k, r);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Adds every hex edge between different territories (or land and sea) to the current path.
  // With `only` set, traces just the outline of that one territory.
  traceBorders(only = -1) {
    const { nb, cellOwner } = this.map;
    const ctx = this.ctx;
    for (const i of this.used) {
      const t = cellOwner[i];
      if (only >= 0 && t !== only) continue;
      const [cx, cy] = this.center(i);
      for (let d = 0; d < 6; d++) {
        const n = nb[i * 6 + d];
        const u = n < 0 ? -1 : cellOwner[n];
        if (u === t || (only < 0 && u > t)) continue; // shared edges are drawn once
        const [ax, ay] = this.corner(cx, cy, (d + 5) % 6, this.s);
        const [bx, by] = this.corner(cx, cy, d, this.s);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }
  }

  outline(tid, color, width) {
    const ctx = this.ctx;
    ctx.beginPath();
    this.traceBorders(tid);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  faceColors(color) {
    if (!this.faces.has(color)) {
      this.faces.set(color, {
        top: mix(color, '#ffffff', 0.55),
        left: mix(color, '#ffffff', 0.15),
        right: mix(color, '#000000', 0.22),
        pip: mix(color, '#000000', 0.55),
      });
    }
    return this.faces.get(color);
  }

  // Isometric cube; (x, y) is the bottom-front vertex.
  drawCube(x, y, w, h, v, f) {
    const ctx = this.ctx;
    const face = (pts, fill) => {
      ctx.beginPath();
      pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.stroke();
    };
    face([[x - w / 2, y - v - h / 2], [x, y - v], [x, y], [x - w / 2, y - h / 2]], f.left);
    face([[x, y - v], [x + w / 2, y - v - h / 2], [x + w / 2, y - h / 2], [x, y]], f.right);
    face([[x, y - v - h], [x + w / 2, y - v - h / 2], [x, y - v], [x - w / 2, y - v - h / 2]], f.top);
    ctx.beginPath();
    ctx.ellipse(x, y - v - h / 2, w * 0.09, w * 0.045, 0, 0, Math.PI * 2);
    ctx.fillStyle = f.pip;
    ctx.fill();
  }

  // Draws the stack and returns the y of its top edge.
  drawStack(t, color) {
    const ctx = this.ctx;
    const [cx, cy] = this.center(t.center);
    const s = this.s;
    const w = s * 0.95, h = w * 0.5, v = w * 0.58;
    const baseY = cy + s * 0.45;
    // Up to 4 dice in the front column, the rest in a column diagonally behind it.
    const cols = t.dice > 4 ? [[w / 4, -h / 4, t.dice - 4], [-w / 4, h / 4, 4]] : [[0, 0, t.dice]];
    const f = this.faceColors(color);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(0.8, s * 0.045);
    ctx.lineJoin = 'round';
    let topY = baseY;
    for (const [dx, dy, n] of cols) {
      for (let k = 0; k < n; k++) this.drawCube(cx + dx, baseY + dy - k * v, w, h, v, f);
      topY = Math.min(topY, baseY + dy - n * v - h);
    }
    return topY;
  }

  draw() {
    const ctx = this.ctx;
    const { width: w, height: h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sea = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    sea.addColorStop(0, '#1f5689');
    sea.addColorStop(1, '#0b2644');
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);
    if (!this.map || !this.view) return;

    const view = this.view;
    const T = this.map.territories;
    const s = this.s;

    // Soft coastline glow, then the territories.
    ctx.beginPath();
    for (const i of this.used) {
      const [cx, cy] = this.center(i);
      this.hexPath(cx, cy, s * 1.25);
    }
    ctx.fillStyle = 'rgba(120, 200, 230, 0.18)';
    ctx.fill();

    for (const t of T) {
      const color = view.players[t.owner].color;
      let fill = color;
      if (t.id === view.selected) fill = mix(color, '#ffffff', 0.45);
      else if (view.targets.has(t.id)) fill = mix(color, '#ffffff', t.id === view.hover ? 0.4 : 0.15);
      else if (t.id === view.hover) fill = mix(color, '#ffffff', 0.2);
      ctx.beginPath();
      for (const c of t.cells) {
        const [cx, cy] = this.center(c);
        this.hexPath(cx, cy, s + 0.6);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }

    ctx.beginPath();
    this.traceBorders();
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = Math.max(1.5, s * 0.16);
    ctx.lineCap = 'round';
    ctx.stroke();

    const hl = Math.max(2, s * 0.22);
    for (const tid of view.targets) this.outline(tid, 'rgba(255,255,255,0.45)', hl * 0.6);
    if (view.battle) {
      this.outline(view.battle.from, '#ffffff', hl);
      this.outline(view.battle.to, '#ffe066', hl);
    } else if (view.selected >= 0) {
      this.outline(view.selected, '#ffffff', hl);
    }

    const order = [...T].sort((a, b) => this.center(a.center)[1] - this.center(b.center)[1]);
    const labels = [];
    for (const t of order) {
      const topY = this.drawStack(t, view.players[t.owner].color);
      if (view.flashes.has(t.id)) labels.push([this.center(t.center)[0], topY, view.flashes.get(t.id)]);
    }

    ctx.font = `700 ${Math.round(Math.max(11, s * 0.85))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.fillStyle = '#ffffff';
    for (const [x, y, n] of labels) {
      ctx.strokeText(`+${n}`, x, y - 2);
      ctx.fillText(`+${n}`, x, y - 2);
    }
  }
}
