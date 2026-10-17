import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts', 'src/http-server.ts'], format: ['esm'], target: 'node22', outDir: 'dist', clean: true, sourcemap: true, dts: true, splitting: false, shims: true, banner: { js: '#!/usr/bin/env node' } });
