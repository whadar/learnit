// Build for the standalone single-file playable: one JS bundle, no dynamic-import chunks,
// because tools/pack-single.mjs inlines the result into one HTML file with no network of its own.
import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: 'bundle.js' } },
  },
});
