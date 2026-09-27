import { describe, it, expect, vi, afterEach } from 'vitest';
import { openExternalUrl } from '@renderer/lib/utils/openExternal';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Every link click opens through one helper, which follows main's rule (no
 * `http://`) and says why when a link can't be opened, instead of the click
 * silently doing nothing.
 */

afterEach(() => {
  vi.restoreAllMocks();
  restoreFiloDefault();
});

describe('openExternalUrl', () => {
  it('an https link goes to the OS', async () => {
    const calls: unknown[][] = [];
    installFiloMock((channel, ...args) => {
      calls.push([channel, ...args]);
      return { success: true };
    });
    await openExternalUrl('https://example.com');
    expect(calls).toEqual([['media:open-external', 'https://example.com']]);
  });

  it('an http link is not sent, and a toast offers the https address', async () => {
    const calls: unknown[] = [];
    installFiloMock((channel) => { calls.push(channel); return { success: true }; });
    const push = vi.spyOn(uiStore, 'pushToast').mockImplementation(() => 0 as never);
    await openExternalUrl('http://example.com/page');
    expect(calls).toEqual([]);
    const toast = push.mock.calls[0]?.[0];
    expect(toast?.text).toMatch(/http:\/\//);
    expect(toast?.actions?.[0]?.label).toBe('Open with https://');
    toast?.actions?.[0]?.handler();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['media:open-external']);
  });

  it('a refusal from main is shown, not swallowed', async () => {
    installFiloMock(() => ({ success: false, error: 'URL not allowed' }));
    const toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    await openExternalUrl('https://192.168.1.1/');
    expect(toast.mock.calls[0]?.[0]).toMatch(/Couldn't open https:\/\/192\.168\.1\.1\//);
  });
});
