import {defineConfig} from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  // ink pulls these in via CJS interop; keep them external so the published
  // package resolves them from node_modules instead of inlining a second copy
  external: ['ink', 'react', 'react/jsx-runtime'],
  banner: {js: '#!/usr/bin/env node'},
})