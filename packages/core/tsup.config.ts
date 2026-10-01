import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { product: 'src/product.ts', index: 'src/cli/stdio.ts', 'http-server': 'src/cli/http.ts' },
  format: ['esm'], target: 'node18', outDir: 'dist', clean: true,
  sourcemap: true, dts: true,
  splitting: false, shims: true,
});
