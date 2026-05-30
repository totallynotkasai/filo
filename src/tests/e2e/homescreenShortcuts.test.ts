import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

/**
 * Phase C / C.5 — Welcome screen Ctrl+N / Ctrl+O shortcuts.
 *
 * The welcome screen advertises the shortcuts in its footer. Before
 * C.5 the bindings were unwired because the global hotkeys registry
 * is only initialised in AppShell once a vault is open. The
 * scoped-listener fix lives in HomeScreen.svelte's $effect.
 *
 * We can't dispatch real native file pickers from a test, so we
 * stub the `vault:select` IPC to return null (cancel). The
 * assertion is: pressing the shortcut fires the IPC at least once.
 */
let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
});

test.describe('Welcome screen shortcuts (Phase C / C.5)', () => {
  test('Ctrl+N invokes the New Vault flow', async () => {
    // Make sure we're on the welcome screen (no vault open).
    await window.evaluate(async () => {
      const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
      vaultStore.setPath('');
    });

    // Replace window.filo.invoke for 'vault:select' so the file picker
    // doesn't actually open. Returning null cancels the flow harmlessly.
    await window.evaluate(() => {
      const w = window as unknown as { __filoSelectCalls?: number; filo: { invoke: (...args: unknown[]) => unknown } };
      w.__filoSelectCalls = 0;
      const original = w.filo.invoke.bind(w.filo);
      w.filo.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:select') {
          w.__filoSelectCalls = (w.__filoSelectCalls ?? 0) + 1;
          return null;
        }
        return original(channel, ...args);
      };
    });

    await window.keyboard.press('Control+N');
    // Give the async handler a tick to dispatch.
    await window.waitForFunction(() => {
      const w = window as unknown as { __filoSelectCalls?: number };
      return (w.__filoSelectCalls ?? 0) >= 1;
    }, undefined, { timeout: 2_000 });

    const calls = await window.evaluate(() => (window as unknown as { __filoSelectCalls?: number }).__filoSelectCalls ?? 0);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test('Ctrl+O invokes the Open Vault flow', async () => {
    await window.evaluate(async () => {
      const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
      vaultStore.setPath('');
    });

    await window.evaluate(() => {
      const w = window as unknown as { __filoSelectCalls?: number; filo: { invoke: (...args: unknown[]) => unknown } };
      w.__filoSelectCalls = 0;
      const original = w.filo.invoke.bind(w.filo);
      w.filo.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:select') {
          w.__filoSelectCalls = (w.__filoSelectCalls ?? 0) + 1;
          return null;
        }
        return original(channel, ...args);
      };
    });

    await window.keyboard.press('Control+O');
    await window.waitForFunction(() => {
      const w = window as unknown as { __filoSelectCalls?: number };
      return (w.__filoSelectCalls ?? 0) >= 1;
    }, undefined, { timeout: 2_000 });

    const calls = await window.evaluate(() => (window as unknown as { __filoSelectCalls?: number }).__filoSelectCalls ?? 0);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
