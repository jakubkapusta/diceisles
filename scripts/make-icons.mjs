// Generates the app icons in public/icons: SVG sources plus PNGs rendered with headless Chrome.
// Usage: node scripts/make-icons.mjs   (set CHROME=/path/to/chrome if it isn't in the default place)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '../public/icons');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const hex = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k + 30);
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

// Pips drawn in a face's own unit square, mapped onto the isometric face with an affine matrix.
const pips = (matrix, spots, r) =>
  `<g transform="matrix(${matrix})">${spots.map(([u, v]) => `<circle cx="${u}" cy="${v}" r="${r}"/>`).join('')}</g>`;

const DIE_DROP = 35; // moves the die down so it stands in the middle of the field

// Island with a raised purple field and a golden die on top, in a 512x512 box.
function art() {
  // Isometric die (before DIE_DROP): bottom vertex at (256, 332), half-width 75, side height 85.
  const L = [181, 201.7], T = [256, 158.4], R = [331, 201.7], B = [256, 245];
  return `
    <polygon points="${hex(256, 334, 165)}" fill="#a98a58"/>
    <polygon points="${hex(256, 318, 165)}" fill="#dcc592"/>
    <polygon points="${hex(256, 318, 148)}" fill="#6e4aa8"/>
    <polygon points="${hex(256, 300, 148)}" fill="#a57be0"/>
    <g transform="translate(0 ${DIE_DROP})">
    <g stroke="#3a2a08" stroke-opacity="0.35" stroke-width="3" stroke-linejoin="round">
      <polygon points="${L} ${B} 256,332 181,288.3" fill="#f2c14e"/>
      <polygon points="${B} ${R} 331,288.3 256,332" fill="#c9962a"/>
      <polygon points="${L} ${T} ${R} ${B}" fill="#ffdd7a"/>
    </g>
    <g fill="#2a1d0a">
      ${pips(`75,-43.3,75,43.3,${L}`, [[0.5, 0.5]], 0.13)}
      ${pips(`75,43.3,0,85,${L}`, [[0.28, 0.28], [0.72, 0.72]], 0.1)}
      ${pips(`75,-43.3,0,85,${B}`, [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]], 0.1)}
    </g>
    </g>`;
}

const sea = `
  <defs>
    <radialGradient id="sea" cx="50%" cy="45%" r="70%">
      <stop offset="0" stop-color="#2a6fa8"/>
      <stop offset="1" stop-color="#0b2644"/>
    </radialGradient>
  </defs>`;

// The art spans y = 152 (top of the field) .. 499 (bottom of the beach); center it at the given scale.
const placed = scale => `<g transform="translate(256 256) scale(${scale}) translate(-256 -326)">${art()}</g>`;

// Regular icon / favicon: rounded tile. Maskable: full-bleed sea with the art inside the safe zone.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${sea}
  <rect width="512" height="512" rx="112" fill="url(#sea)"/>${placed(0.9)}
</svg>`;
const fullBleed = scale => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${sea}
  <rect width="512" height="512" fill="url(#sea)"/>${placed(scale)}
</svg>`;

// favicon.svg ships with the site; the others are only sources for the PNGs.
writeFileSync(join(OUT, 'favicon.svg'), rounded);
const tmp = mkdtempSync(join(tmpdir(), 'icons-'));
const sources = {
  'icon.svg': rounded,
  'icon-maskable.svg': fullBleed(0.7), // Android crops maskable icons to a circle of 80% diameter
  'icon-square.svg': fullBleed(0.84), // iOS rounds the corners itself
};
for (const [name, svg] of Object.entries(sources)) writeFileSync(join(tmp, name), svg);

const renders = [
  ['icon.svg', 'favicon-32.png', 32],
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon-square.svg', 'apple-touch-icon.png', 180],
];
try {
  for (const [i, [src, out, size]] of renders.entries()) {
    const page = join(tmp, `page-${i}.html`);
    writeFileSync(page, `<html><body style="margin:0;background:transparent">
      <img src="file://${join(tmp, src)}" width="${size}" height="${size}" style="display:block"></body></html>`);
    rmSync(join(OUT, out), { force: true });
    try {
      execFileSync(CHROME, [
        '--headless=new', '--hide-scrollbars', '--default-background-color=00000000',
        `--window-size=${size},${size}`, `--user-data-dir=${join(tmp, `profile-${i}`)}`,
        `--screenshot=${join(OUT, out)}`, `file://${page}`,
      ], { stdio: 'ignore', timeout: 20000 });
    } catch (err) {
      // Headless Chrome sometimes lingers after writing the screenshot; that's fine if the file exists.
      if (!existsSync(join(OUT, out))) throw err;
    }
    console.log(`${out} (${size}px)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
