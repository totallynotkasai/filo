// Runs the corpus check (npm run corpus:run). Same runtime as the `unit`
// project in vitest.config.mts, pointed at the runner. Kept out of the test
// projects, so ci:verify never runs it: a large corpus takes most of an hour.
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/tests/corpus/corpusRun.ts'],
    setupFiles: ['src/tests/setup.ts'],
    // The runner's progress lines, which vitest would hold back for a passing test.
    disableConsoleIntercept: true,
  },
});
