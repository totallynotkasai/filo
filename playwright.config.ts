import { defineConfig } from '@playwright/test';

// The specs drive the built app (`dist/main/main.js`): run `npm run build`
// first. One worker: parallel Electron instances fight over
// `DevToolsActivePort`, and each spec owns the window it drives.
export default defineConfig({
  testDir: './src/tests/e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
