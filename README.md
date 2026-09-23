# Dice Isles

A single-player dice strategy game for the browser, inspired by the classic Dice Wars.
Conquer the island by attacking neighbouring fields with your dice; AI opponents play the other colours.

- 3D board (three.js) with an animated sea, or a flat 2D mode
- 1–7 AI opponents, three map sizes, random maps you can re-roll before starting
- Procedural sound effects, works on phones

## Development

```bash
npm install
npm run dev
```

`npm run build` produces a single self-contained `dist/index.html` that also works when opened
directly from disk. Pushes to `main` are deployed to GitHub Pages by `.github/workflows/pages.yml`.
