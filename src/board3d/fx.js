import * as THREE from 'three';

// Colors above 1.0 are picked up by the bloom pass, so glowing effects use boosted HDR colors.
const glow = (color, k) => new THREE.Color(color).multiplyScalar(k);

function makeSpriteTexture() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(canvas);
}

const additive = color => ({
  color,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.sprite = makeSpriteTexture();
  }

  add(object, update) {
    this.scene.add(object);
    const item = { object, update, done: false };
    this.items.push(item);
    return item;
  }

  // Glowing arc from the attacking stack to the target; grows in, then fades when `release()` is called.
  arc(from, to, color, growTime) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 1.2 + from.distanceTo(to) * 0.35;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const geometry = new THREE.TubeGeometry(curve, 64, 0.07, 8, false);
    const material = new THREE.MeshBasicMaterial(additive(glow(color, 2.5)));
    const tube = new THREE.Mesh(geometry, material);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.sprite, ...additive(glow(color, 5)) }));
    head.scale.setScalar(0.55);
    const group = new THREE.Group();
    group.add(tube, head);
    const total = geometry.index.count;
    let start = null, releasedAt = null;
    const item = this.add(group, now => {
      start ??= now;
      const grow = Math.min(1, (now - start) / Math.max(growTime, 0.05));
      geometry.setDrawRange(0, Math.floor((total * grow) / 3) * 3);
      head.position.copy(curve.getPoint(grow));
      head.scale.setScalar(0.45 + Math.sin(now * 18) * 0.08);
      if (releasedAt !== null) {
        const fade = 1 - (now - releasedAt) / 0.3;
        material.opacity = head.material.opacity = Math.max(0, fade);
        return fade > 0;
      }
      return true;
    });
    item.release = now => { releasedAt ??= now; };
    return item;
  }

  sparks(position, color, count = 70) {
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions.set([position.x, position.y, position.z], i * 3);
      const a = Math.random() * Math.PI * 2, up = 2 + Math.random() * 4, out = 1 + Math.random() * 3;
      velocities.push(new THREE.Vector3(Math.cos(a) * out, up, Math.sin(a) * out));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ map: this.sprite, size: 0.28, ...additive(glow(color, 4)) });
    const points = new THREE.Points(geometry, material);
    let last = null, start = null;
    this.add(points, now => {
      start ??= now;
      const dt = last === null ? 0 : now - last;
      last = now;
      const t = (now - start) / 1.1;
      for (let i = 0; i < count; i++) {
        const v = velocities[i];
        v.y -= 9 * dt;
        v.multiplyScalar(1 - 1.5 * dt);
        positions[i * 3] += v.x * dt;
        positions[i * 3 + 1] += v.y * dt;
        positions[i * 3 + 2] += v.z * dt;
      }
      geometry.attributes.position.needsUpdate = true;
      material.opacity = Math.max(0, 1 - t);
      material.size = 0.28 * (1 - t * 0.5);
      return t < 1;
    });
  }

  shockwave(position, color) {
    const geometry = new THREE.RingGeometry(0.8, 1, 64).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ ...additive(glow(color, 3)), side: THREE.DoubleSide });
    const ring = new THREE.Mesh(geometry, material);
    ring.position.copy(position);
    let start = null;
    this.add(ring, now => {
      start ??= now;
      const t = (now - start) / 0.7;
      const k = 1 - (1 - Math.min(t, 1)) ** 3;
      ring.scale.setScalar(0.3 + k * 2.8);
      material.opacity = Math.max(0, 1 - t);
      return t < 1;
    });
  }

  update(now) {
    for (const item of this.items) {
      if (!item.update(now)) {
        item.done = true;
        this.dispose(item.object);
      }
    }
    this.items = this.items.filter(i => !i.done);
  }

  clear() {
    for (const item of this.items) this.dispose(item.object);
    this.items = [];
  }

  dispose(object) {
    this.scene.remove(object);
    object.traverse(o => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
}
