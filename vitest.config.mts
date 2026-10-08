import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
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
    // Four projects. `unit` runs the plain unit tests. `component` mounts
    // real `.svelte` components in jsdom, which needs the `browser` export
    // condition (the bare `svelte` import otherwise resolves to the server
    // entry and `mount()` throws
    // `lifecycle_outside_component`). The condition is scoped to the
    // component project so the unit suite keeps its resolution. `browser`
    // runs in real Chromium, for what jsdom can't imitate.
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
      {
        // The editor in the engine Filo ships: jsdom lays nothing out, and its
        // selection, focus and contenteditable behaviour differ from Chromium's.
        // Playwright's headless Chromium, installed once per machine with
        // `npx playwright install --only-shell chromium`. The root `jsdom`
        // environment doesn't apply here.
        extends: true,
        resolve: { conditions: ['browser'] },
        // Bundled with the editor up front: found mid-run, it is bundled on
        // its own, and its decorations are then another copy's to the editor.
        // The Svelte compiler (a spec compiles a component's styles) and the
        // table plugins (the editor's zoomed column drag) likewise, or finding
        // one mid-run reloads the page under the running specs.
        optimizeDeps: { include: ['@tiptap/pm/view', '@tiptap/pm/tables', 'svelte/compiler'] },
        test: {
          name: 'browser',
          include: ['src/tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      // Ratchet-style coverage gate for `src/renderer/lib/**` — the pure
      // logic surface that should always be unit-testable. Components and
      // stores are excluded because they currently rely on a real browser
      // shell, not jsdom. Ratchet up only: raise a
      // threshold whenever new tests push coverage past it, never lower one.
      // Known gaps: lib/editor (TipTap), most of lib/canvas
      // gesture handlers, and the lib/**/persistence helpers that the
      // renderer can't currently exercise without a vault on disk.
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/renderer/lib/**/*.ts'],
      exclude: ['src/renderer/lib/**/*.svelte.ts'],
      // Floors 2-3 points under the measured (Windows) lines 90.4, branches 79.6, functions 92.4,
      // statements 87.8: the Linux CI job skips some Windows-only paths.
      thresholds: {
        lines: 88,
        branches: 77,
        functions: 90,
        statements: 85,
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
