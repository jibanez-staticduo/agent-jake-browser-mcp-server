import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { product: 'src/product.ts', index: 'src/index.ts', 'http-server': 'http/server.js' },
  format: ['esm'], target: 'node18', outDir: 'dist', clean: true,
  sourcemap: true, dts: { entry: { product: 'src/product.ts', index: 'src/index.ts' } },
  splitting: false, shims: true,
});
