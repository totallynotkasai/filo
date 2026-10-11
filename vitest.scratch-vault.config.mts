// Builds the manual-testing scratch vault (npm run scratch-vault). Same runtime as
// the `characterisation` project in vitest.config.mts, pointed at the builder.
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/tests/characterisation/scratchVault/buildScratchVault.ts'],
    setupFiles: ['src/tests/setup.ts', 'src/tests/characterisation/setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
