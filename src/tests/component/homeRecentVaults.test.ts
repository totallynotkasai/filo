/**
 * Home drops a recent vault only when its folder is confirmed gone, and never
 * a pinned one. Staying in the current vault (Cancel on the leave dialog), a
 * drive that is unplugged for now, or any other failure leaves the entry
 * listed; it used to be removed with a "moved or deleted" message.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import HomeScreen from '@renderer/components/home/HomeScreen.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { openVaultFailureOf, type OpenVaultFailure, type OpenVaultReport } from '@renderer/lib/vault/vaultOpenFailure';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';

let host: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

afterEach(() => {
  if (app) unmount(app);
  host?.remove();
  app = null;
  host = null;
  vi.restoreAllMocks();
  restoreFiloDefault();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** Home with one recent vault; opening it fails with `failure`. Returns the paths removed from recents. */
async function openRecentThatFails(failure: OpenVaultFailure, pinned: boolean): Promise<string[]> {
  const removed: string[] = [];
  const recent = { name: 'Books', path: 'E:/Books', lastOpened: 1, pinned };
  installFiloMock({
    'vault:list-recents': () => [recent],
    'vault:get-launch-preference': () => ({ openOnLaunch: false }),
    'vault:remove-recent': (path: unknown) => {
      removed.push(String(path));
      return [];
    },
  });
  vi.spyOn(vaultStore, 'openVault').mockImplementation(async (_path: string, report?: OpenVaultReport) => {
    if (report) report.failure = failure;
    return false;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(HomeScreen, { target: host, props: {} });
  await settle();
  const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Open Books"]');
  if (!btn) throw new Error('no recent row');
  btn.click();
  await settle();
  return removed;
}

describe('opening a recent vault that does not open', () => {
  it('the user stayed in the current vault: kept, and no "moved or deleted" message', async () => {
    expect(await openRecentThatFails('cancelled', false)).toEqual([]);
    expect(uiStore.toasts.some((t) => /moved or deleted/.test(t.text))).toBe(false);
  });

  it('its drive is not available: kept', async () => {
    expect(await openRecentThatFails('unavailable', false)).toEqual([]);
    expect(uiStore.toasts.some((t) => /isn't available right now/.test(t.text))).toBe(true);
  });

  it('any other failure: kept', async () => {
    expect(await openRecentThatFails('failed', false)).toEqual([]);
  });

  it('the folder is gone: removed', async () => {
    expect(await openRecentThatFails('missing', false)).toEqual(['E:/Books']);
  });

  it('the folder is gone but the entry is pinned: kept', async () => {
    expect(await openRecentThatFails('missing', true)).toEqual([]);
    expect(uiStore.toasts.some((t) => /stays pinned/.test(t.text))).toBe(true);
  });
});

describe('why a vault did not open', () => {
  it('only vault:init-config speaks for the folder itself', () => {
    expect(openVaultFailureOf(new IpcEnvelopeError('vault:init-config', 'x', 'ENOENT'))).toBe('missing');
    expect(openVaultFailureOf(new IpcEnvelopeError('vault:init-config', 'x', 'ENOTDIR'))).toBe('missing');
    expect(openVaultFailureOf(new IpcEnvelopeError('vault:init-config', 'x', 'ENODEV'))).toBe('unavailable');
    expect(openVaultFailureOf(new IpcEnvelopeError('vault:init-config', 'x', 'EACCES'))).toBe('failed');
    expect(openVaultFailureOf(new IpcEnvelopeError('config:load-all', 'x', 'ENOENT'))).toBe('failed');
    expect(openVaultFailureOf(new Error('boom'))).toBe('failed');
  });
});
