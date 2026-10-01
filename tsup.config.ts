import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['entrypoints/index.ts', 'entrypoints/http-server.ts'], format: ['esm'],
  target: 'node18', outDir: 'dist', clean: true, sourcemap: true, dts: true,
  splitting: false, shims: true, banner: { js: '#!/usr/bin/env node' },
});
