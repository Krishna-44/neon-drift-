import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built bundle also works under Electron's app:// protocol.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  // Vitest configuration (logic modules are engine-agnostic and run in node).
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['tests/**/*.bench.ts'],
    },
  },
} as any);
