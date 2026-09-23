import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const DIE = 0.66;
const MAX_INSTANCES = 1500;
const FACE_VALUES = [1, 6, 2, 5, 3, 4]; // BoxGeometry face order: +x, -x, +y, -y, +z, -z
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.25], [0.72, 0.25], [0.28, 0.5], [0.72, 0.5], [0.28, 0.75], [0.72, 0.75]],
};
const GRAVITY = -14;

// One texture with all six faces side by side: white face, dark pips. Instance color tints the white.
function makeFaceAtlas() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S * 6;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, S);
  FACE_VALUES.forEach((value, f) => {
    for (const [u, v] of PIPS[value]) {
      const g = ctx.createRadialGradient(f * S + u * S - 2, v * S - 2, 1, f * S + u * S, v * S, S * 0.085);
      g.addColorStop(0, '#3a4356');
      g.addColorStop(1, '#141a26');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f * S + u * S, v * S, S * 0.085, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeDieGeometry() {
  const geometry = new RoundedBoxGeometry(DIE, DIE, DIE, 3, DIE * 0.17);
  const uv = geometry.attributes.uv, index = geometry.index;
  for (const group of geometry.groups) {
    const seen = new Set();
    for (let k = group.start; k < group.start + group.count; k++) {
      const v = index ? index.getX(k) : k;
      if (seen.has(v)) continue;
      seen.add(v);
      uv.setX(v, (group.materialIndex + uv.getX(v)) / 6);
    }
  }
  geometry.clearGroups();
  return geometry;
}

const QUARTER = Math.PI / 2;
function randomOrientation() {
  const e = new THREE.Euler(QUARTER * (Math.random() * 4 | 0), QUARTER * (Math.random() * 4 | 0), 0);
  const base = new THREE.Quaternion().setFromEuler(e);
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.35);
  return yaw.multiply(base);
}

function easeOutBounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class DiceLayer {
  constructor(scene) {
    this.material = new THREE.MeshPhysicalMaterial({
      map: makeFaceAtlas(),
      roughness: 0.32,
      clearcoat: 0.7,
      clearcoatRoughness: 0.2,
    });
    this.mesh = new THREE.InstancedMesh(makeDieGeometry(), this.material, MAX_INSTANCES);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, new THREE.Color());
    scene.add(this.mesh);
    this.dice = [];
    this.byTerritory = new Map();
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._target = new THREE.Vector3();
  }

  reset() {
    this.dice = [];
    this.byTerritory.clear();
  }

  spawn(tid, index, owner, color, delay, now) {
    return {
      tid, index, owner,
      color: color.clone(),
      pos: new THREE.Vector3(0, -100, 0),
      quat: randomOrientation(),
      jitter: [(Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05],
      anim: 'drop', t0: now + delay, dur: 0.6,
      vel: new THREE.Vector3(), spin: new THREE.Vector3(),
    };
  }

  scatter(die, now) {
    const a = Math.random() * Math.PI * 2;
    die.anim = 'remove';
    die.t0 = now;
    die.dur = 0.9;
    die.vel.set(Math.cos(a) * (1.5 + Math.random() * 2), 3 + Math.random() * 2.5, Math.sin(a) * (1.5 + Math.random() * 2));
    die.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18);
  }

  // Brings the displayed dice in line with the game state; new dice drop in, missing ones scatter.
  sync(territories, colors, now, stagger = 0) {
    for (const t of territories) {
      let list = this.byTerritory.get(t.id) || [];
      if (list.length && list[0].owner !== t.owner) {
        for (const die of list) this.scatter(die, now);
        list = [];
      }
      while (list.length > t.dice) this.scatter(list.pop(), now);
      const base = stagger ? Math.random() * stagger : 0;
      while (list.length < t.dice) {
        const die = this.spawn(t.id, list.length, t.owner, colors[t.owner], base + list.length * 0.06, now);
        list.push(die);
        this.dice.push(die);
      }
      this.byTerritory.set(t.id, list);
    }
  }

  // After a battle: on a win the attacking stack (all but one die) flies onto the conquered field.
  resolveBattle(fromId, toId, won, now) {
    const src = this.byTerritory.get(fromId) || [];
    const moving = src.splice(1);
    if (!won) {
      for (const die of moving) this.scatter(die, now);
      return;
    }
    for (const die of this.byTerritory.get(toId) || []) this.scatter(die, now);
    moving.forEach((die, i) => {
      die.tid = toId;
      die.index = i;
      die.anim = 'fly';
      die.from = die.pos.clone();
      die.t0 = now + i * 0.05;
      die.dur = 0.5;
    });
    this.byTerritory.set(toId, moving);
  }

  // slot(tid, index, count, out) writes the resting position of a die. Returns true while any die moves.
  update(dt, now, slot) {
    const { _m: m, _s: s, _q: q, _target: target } = this;
    for (const [tid, list] of this.byTerritory) {
      list.forEach((die, i) => { die.index = i; die.count = list.length; die.tid = tid; });
    }
    let n = 0, moving = false;
    const alive = [];
    for (const die of this.dice) {
      let scale = 1;
      if (die.anim === 'remove') {
        const t = (now - die.t0) / die.dur;
        if (t >= 1) continue;
        moving = true;
        die.vel.y += GRAVITY * dt;
        die.pos.addScaledVector(die.vel, dt);
        q.setFromEuler(new THREE.Euler(die.spin.x * dt, die.spin.y * dt, die.spin.z * dt));
        die.quat.premultiply(q);
        scale = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      } else {
        slot(die.tid, die.index, die.count, target);
        target.x += die.jitter[0];
        target.z += die.jitter[1];
        const t = (now - die.t0) / die.dur;
        if (die.anim === 'drop') {
          if (t < 0) {
            scale = 0;
          } else if (t < 1) {
            die.pos.set(target.x, target.y + (1 - easeOutBounce(t)) * (2.6 + die.index * 0.25), target.z);
          } else {
            die.anim = null;
            this.onLand?.();
          }
        } else if (die.anim === 'fly') {
          if (t < 1) {
            const k = easeInOut(Math.max(0, t));
            die.pos.lerpVectors(die.from, target, k);
            die.pos.y += Math.sin(Math.PI * k) * 1.4;
          } else {
            die.anim = null;
          }
        }
        if (!die.anim) {
          if (die.pos.distanceToSquared(target) > 1e-6) moving = true;
          die.pos.lerp(target, 1 - Math.exp(-dt * 14));
        } else {
          moving = true;
        }
      }
      alive.push(die);
      if (n >= MAX_INSTANCES) continue;
      s.setScalar(Math.max(scale, 0.0001));
      m.compose(die.pos, die.quat, s);
      this.mesh.setMatrixAt(n, m);
      this.mesh.setColorAt(n, die.color);
      die.instance = n;
      n++;
    }
    this.dice = alive;
    this.mesh.count = n;
    this.mesh.boundingSphere = null; // recomputed lazily by the raycaster from current positions
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return moving;
  }

  // Territory id of the die under a raycast hit, or -1.
  territoryAt(instanceId) {
    const die = this.dice.find(d => d.instance === instanceId);
    return die && die.anim !== 'remove' ? die.tid : -1;
  }
}
