import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'jsdom',
    exclude: ['src/tests/e2e/**'],
    globals: true,
    setupFiles: ['src/tests/setup.ts'],
    // Audit-19 0.1 (T0): two projects. `unit` is the historical config,
    // unchanged. `component` mounts real `.svelte` components in jsdom, which
    // needs the `browser` export condition (the bare `svelte` import otherwise
    // resolves to the server entry and `mount()` throws
    // `lifecycle_outside_component`). The condition is scoped to the
    // component project so the unit suite keeps its resolution.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'component',
          include: ['src/tests/component/**/*.test.ts'],
        },
      },
      {
        // The refactor characterisation suite: the real app (renderer stores
        // and components plus the real main-process IPC handlers) against a
        // real temp vault. Same `browser` condition as `component`; its own
        // setup swaps in the fake `electron` shell the main handlers import.
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'characterisation',
          include: ['src/tests/characterisation/**/*.test.ts'],
          setupFiles: ['src/tests/setup.ts', 'src/tests/characterisation/setup.ts'],
          // Each case opens a real vault and waits out real debounces.
          testTimeout: 120000,
          hookTimeout: 30000,
        },
      },
    ],
    coverage: {
      // Ratchet-style coverage gate for `src/renderer/lib/**` — the pure
      // logic surface that should always be unit-testable. Components and
      // stores are excluded because they currently rely on a real browser
      // shell, not jsdom. The branch floor of 70 is the first MEASURED one
      // (an earlier 80 was never actually run). Ratchet up only: raise a
      // threshold whenever new tests push coverage past it, never lower one.
      // Known gaps: lib/editor (TipTap), most of lib/canvas
      // gesture handlers, and the lib/**/persistence helpers that the
      // renderer can't currently exercise without a vault on disk.
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/renderer/lib/**/*.ts'],
      exclude: ['src/renderer/lib/**/*.svelte.ts'],
      thresholds: {
        lines: 45,
        branches: 70,
        functions: 75,
        statements: 45,
      },
    },
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
