import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // Inline all JS and CSS into dist/index.html. Browsers refuse to load separate module
  // scripts over file://, so this is what lets the build open with a double-click
  // as well as from any static host.
  plugins: [viteSingleFile()],
  base: './',
  build: {
    chunkSizeWarningLimit: 800, // three.js alone is ~600 kB minified
  },
});
