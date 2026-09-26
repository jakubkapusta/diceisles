import * as THREE from 'three';

const MASK_SIZE = 512;
const MASK_MARGIN = 8; // world units of sea around the land covered by the mask

// Blurred land mask: 1 on land, fading to 0 a couple of units offshore. Drives shallows and foam.
export function buildShoreMask(map, grid) {
  const b = grid.bounds;
  const rect = {
    x: b.minX - MASK_MARGIN, z: b.minZ - MASK_MARGIN,
    w: b.maxX - b.minX + 2 * MASK_MARGIN, h: b.maxZ - b.minZ + 2 * MASK_MARGIN,
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK_SIZE;
  // Read back right away: a CPU canvas avoids a slow GPU readback (a noticeable hitch on phones).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
  ctx.fillStyle = '#fff';
  const sx = MASK_SIZE / rect.w, sz = MASK_SIZE / rect.h;
  ctx.beginPath();
  for (let i = 0; i < map.cellOwner.length; i++) {
    if (map.cellOwner[i] < 0) continue;
    for (let k = 0; k < 6; k++) {
      const [x, z] = grid.corner(i, k);
      const px = (x - rect.x) * sx, pz = (z - rect.z) * sz;
      if (k === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
    }
    ctx.closePath();
  }
  ctx.fill();

  const src = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
  let buf = new Float32Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = src[i * 4] / 255;
  const radius = Math.max(2, Math.round(1.1 * sx));
  for (let pass = 0; pass < 3; pass++) buf = boxBlur(buf, MASK_SIZE, radius);

  const data = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(buf[i] * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, MASK_SIZE, MASK_SIZE);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, rect };
}

// Separable box blur (horizontal then vertical) with clamped edges.
function boxBlur(src, n, r) {
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < n; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * n + Math.min(n - 1, Math.max(0, x))];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc * norm;
      acc += src[y * n + Math.min(n - 1, x + r + 1)] - src[y * n + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(n - 1, Math.max(0, y)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc * norm;
      acc += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x];
    }
  }
  return out;
}

// Ocean surface: Gerstner waves displace a dense mesh (real moving geometry, correct normals),
// damped near the island so the shore stays calm; fine ripples are added per pixel.
const vertexShader = /* glsl */`
  uniform float uTime;
  uniform sampler2D uMask;
  uniform vec4 uMaskRect;
  uniform float uAmp;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vCrest;
  varying float vShore;
  varying float vHeight;
  varying float vSurge;
  #include <fog_pars_vertex>

  float shoreMask(vec2 xz) {
    vec2 uv = (xz - uMaskRect.xy) / uMaskRect.zw;
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
    return texture2D(uMask, uv).r;
  }

  // wave.xy = direction, wave.z = steepness, wave.w = wavelength. Deep-water dispersion: c = sqrt(g / k).
  void gerstner(vec4 wave, vec2 p, float damp, inout vec3 offset, inout vec3 tangent, inout vec3 binormal, inout float crest) {
    float k = 6.28318 / wave.w;
    float c = sqrt(2.5 / k);
    vec2 d = normalize(wave.xy);
    float f = k * (dot(d, p) - c * uTime);
    float q = wave.z * damp;
    float a = q / k;
    float s = sin(f), co = cos(f);
    offset += vec3(d.x * a * co, a * s, d.y * a * co);
    tangent += vec3(-d.x * d.x * q * s, d.x * q * co, -d.x * d.y * q * s);
    binormal += vec3(-d.x * d.y * q * s, d.y * q * co, -d.y * d.y * q * s);
    crest += q * s;
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 p = world.xz;
    float shore = shoreMask(p);
    float damp = uAmp * (1.0 - 0.8 * smoothstep(0.0, 0.45, shore));
    vec3 offset = vec3(0.0), tangent = vec3(1.0, 0.0, 0.0), binormal = vec3(0.0, 0.0, 1.0);
    float crest = 0.0;
    // Only waves long enough for the mesh resolution move vertices; shorter ones live in the fragment shader.
    // Shorter waves fade out far away, where the mesh gets too sparse to carry them.
    float nearDamp = damp * (1.0 - smoothstep(35.0, 70.0, length(p)));
    // Non-commensurate wavelengths spread around the wind direction, so the pattern never tiles.
    gerstner(vec4(1.0, 0.25, 0.13, 11.3), p, damp, offset, tangent, binormal, crest);
    gerstner(vec4(0.9, -0.55, 0.12, 7.9), p, damp, offset, tangent, binormal, crest);
    gerstner(vec4(0.55, 0.85, 0.11, 5.7), p, damp, offset, tangent, binormal, crest);
    gerstner(vec4(1.0, -0.15, 0.10, 4.3), p, nearDamp, offset, tangent, binormal, crest);
    gerstner(vec4(0.2, -1.0, 0.08, 3.1), p, nearDamp, offset, tangent, binormal, crest);
    gerstner(vec4(0.75, 0.65, 0.07, 2.6), p, nearDamp, offset, tangent, binormal, crest);
    // Surf: near the beach the water level rises and falls, with the phase travelling towards the
    // shore, so each surge runs up the sloped sand and pulls back again.
    float surfZone = smoothstep(0.1, 0.3, shore);
    float surge = sin(uTime * 1.8 - shore * 28.0);
    offset.y += surge * 0.05 * surfZone;
    vSurge = surge * surfZone;

    world.xyz += offset;
    vWorld = world.xyz;
    vNormalW = normalize(cross(binormal, tangent));
    vCrest = crest;
    vShore = shore;
    vHeight = offset.y;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uScatter;
  uniform vec3 uFoam;
  uniform vec3 uSand;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vCrest;
  varying float vShore;
  varying float vHeight;
  varying float vSurge;
  #include <fog_pars_fragment>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  // Slope of a short sine wave (same deep-water dispersion as the vertex waves).
  vec2 shortWave(vec2 p, vec2 dir, float wavelength, float amp) {
    float k = 6.28318 / wavelength;
    vec2 d = normalize(dir);
    return d * (amp * k * cos(k * (dot(d, p) - sqrt(2.5 / k) * uTime)));
  }

  void main() {
    float dist = length(cameraPosition - vWorld);
    float detail = 1.0 - smoothstep(25.0, 90.0, dist); // fade tiny waves out before they alias
    // Short chop and ripples: cheap analytic waves in scattered directions (no per-pixel noise).
    vec2 p = vWorld.xz;
    vec2 g = shortWave(p, vec2(-0.4, 1.0), 2.1, 0.035)
           + shortWave(p, vec2(0.9, -0.1), 1.4, 0.022)
           + shortWave(p, vec2(0.6, 0.8), 0.9, 0.012)
           + shortWave(p, vec2(-0.9, 0.35), 0.63, 0.008)
           + shortWave(p, vec2(0.2, -1.0), 0.47, 0.006)
           + shortWave(p, vec2(-0.7, -0.7), 0.37, 0.005);
    g *= detail;
    vec3 N = normalize(normalize(vNormalW) + vec3(-g.x, 0.0, -g.y));
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uSunDir);

    // Water body: darker in the deep, turquoise over the shallows, light scattering through crests.
    float shallow = smoothstep(0.02, 0.4, vShore);
    // Seen from above water is mostly its own color; waves read through reflections and glints.
    float light = max(dot(N, L), 0.0);
    vec3 body = mix(uDeep, uShallow, shallow) * (0.68 + 0.45 * light);
    body += uScatter * clamp(vHeight * 2.5, 0.0, 1.0) * 0.35;

    // Sky reflection weighted by Schlick's Fresnel, plus a tight sun highlight.
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(R.y, 0.0, 1.0));
    float fresnel = 0.08 + 0.92 * pow(1.0 - max(dot(N, V), 0.0), 5.0); // slightly boosted for readability
    vec3 col = mix(body, sky, fresnel);
    float sunDot = max(dot(R, L), 0.0);
    col += uSunColor * (pow(sunDot, 600.0) * 1.6 + pow(sunDot, 40.0) * 0.1);

    // Foam: whitecaps on the sharpest crests and a lapping band along the shore.
    float n = noise(p * 1.8 + uTime * 0.15);
    // Whitecaps: thin, broken streaks only where several crests line up.
    float streaks = smoothstep(0.5, 0.85, noise(p * vec2(3.5, 6.0) + vec2(uTime * 0.4, 0.0)));
    float whitecaps = smoothstep(0.34, 0.42, vCrest) * streaks * 0.6 * detail;
    // Surf zone: the shore mask runs from ~0.1 offshore to ~0.33 at the waterline on the beach.
    float lacy = noise(p * 5.0 - uTime * 0.3);
    // Breakers: foam on the crest of each surge as it rolls in (same phase as the vertex surge).
    float breaker = smoothstep(0.72, 1.0, sin(uTime * 1.8 - vShore * 28.0 + n * 0.9))
                  * smoothstep(0.1, 0.27, vShore) * (0.45 + 0.55 * lacy);
    // Swash: a foam edge riding up and down the sand with the surge.
    float edge = smoothstep(0.26, 0.31, vShore + vSurge * 0.035);
    float swash = edge * (0.7 + 0.3 * lacy);
    // Lace: broken foam left behind just offshore as the water pulls back.
    float lace = smoothstep(0.18, 0.27, vShore) * (1.0 - edge) * smoothstep(0.55, 0.8, lacy) * 0.55;
    float foam = clamp(whitecaps + breaker * 0.75 + swash + lace, 0.0, 1.0);
    // The last stretch before the waterline takes on the color of the sand below (clear shallows).
    col = mix(col, uSand, smoothstep(0.2, 0.33, vShore) * 0.45);
    col = mix(col, uFoam * (0.8 + 0.2 * max(dot(N, L), 0.0)), foam * 0.85);

    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

// Grid that is dense near the board and sparse towards the horizon (x -> R * (0.35u + 0.65u^3)).
function makeOceanGeometry(radius = 250, segments = 300) {
  const geometry = new THREE.PlaneGeometry(2, 2, segments, segments).rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  const warp = u => radius * (0.35 * u + 0.65 * u * u * u);
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, warp(pos.getX(i)));
    pos.setZ(i, warp(pos.getZ(i)));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function createWater(sunDir) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uAmp: { value: 0.8 },
      uMask: { value: null },
      uMaskRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uDeep: { value: new THREE.Color('#093a66') },
      uShallow: { value: new THREE.Color('#1a86b0') },
      uScatter: { value: new THREE.Color('#3bb8e0') },
      uFoam: { value: new THREE.Color('#e8f4f4') },
      uSand: { value: new THREE.Color('#9fb58f') },
      uSkyTop: { value: new THREE.Color('#3d76ad') },
      uSkyHorizon: { value: new THREE.Color('#90bde3') },
      uSunDir: { value: sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Color('#ffe9c4') },
    },
  ]);
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, fog: true });
  const mesh = new THREE.Mesh(makeOceanGeometry(), material);
  mesh.frustumCulled = false;
  return {
    mesh,
    setMask({ texture, rect }) {
      uniforms.uMask.value?.dispose();
      uniforms.uMask.value = texture;
      uniforms.uMaskRect.value.set(rect.x, rect.z, rect.w, rect.h);
    },
    update(time) {
      uniforms.uTime.value = time;
    },
  };
}
