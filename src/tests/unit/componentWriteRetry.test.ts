import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { themeStore } from '@renderer/stores/theme.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __resetDirtyTrackingForTests,
  isUnsavedWorkEmpty,
  reportedFailedPaths,
  retryAllFailedWrites,
  unsavedWork,
} from '@renderer/lib/boards/writeStateTracking';
import { unsavedComponentPayloads } from '@renderer/lib/boards/componentWriteRetry';
import { saveLayoutTemplate, deleteLayoutTemplate } from '@renderer/lib/templates/layoutTemplateStore';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ThemeFile } from '@renderer/lib/themes/themeManager';
import type { LayoutTemplate } from '@renderer/schema/index';

/**
 * A theme or template save, a theme or template delete, and a note's
 * exclusive create have no scheduler behind them. A failure used to leave the
 * path failed for the whole session: Retry had nothing to fire, save() stayed
 * false, and every close asked "couldn't be saved" (with a rescue copy it
 * couldn't write). Now a locked save is kept for Retry (and for a rescue
 * copy), and a failure nothing can retry is reported, not left failed.
 */

const VAULT = '/vault';
const THEME: ThemeFile = { id: 'mine', name: 'Mine', base: 'light', variables: { '--accent-primary': '#ff0000' } };

describe('failed component writes', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    themeStore.clear();
    vaultStore.setPath(VAULT);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    restoreFiloDefault();
    vaultStore.setPath('');
    themeStore.clear();
    __resetDirtyTrackingForTests();
  });

  it('a locked theme save is kept: Retry saves it, and until then a rescue copy has its text', async () => {
    let locked = true;
    const saves: unknown[] = [];
    installFiloMock({
      'theme:save': (...args: unknown[]) => {
        saves.push(args[2]);
        return locked ? { ok: false, code: 'EBUSY', error: 'locked' } : { ok: true };
      },
    });

    expect(await themeStore.saveTheme(VAULT, THEME)).toBeNull();
    expect(unsavedWork().failed).toEqual(['.filo/themes/mine.json']);
    const rescue = unsavedComponentPayloads();
    expect(rescue).toHaveLength(1);
    expect(JSON.parse(rescue[0]?.text ?? '')).toEqual(THEME);

    locked = false;
    const { failed } = await retryAllFailedWrites();
    expect(failed).toEqual([]);
    expect(saves).toHaveLength(2);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
    expect(themeStore.cache.mine).toEqual(THEME);
    expect(unsavedComponentPayloads()).toEqual([]);
  });

  it('a save that fails again on Retry is kept again', async () => {
    installFiloMock({ 'theme:save': () => ({ ok: false, code: 'EBUSY', error: 'locked' }) });
    await themeStore.saveTheme(VAULT, THEME);
    expect((await retryAllFailedWrites()).failed).toEqual(['.filo/themes/mine.json']);
    expect(unsavedWork().failed).toEqual(['.filo/themes/mine.json']);
    expect(unsavedComponentPayloads()).toHaveLength(1);
  });

  it('a failure a retry cannot fix is reported, not left failed', async () => {
    installFiloMock({ 'theme:save': () => ({ ok: false, code: 'FILE_TOO_LARGE', error: 'too big' }) });
    await themeStore.saveTheme(VAULT, THEME);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
    expect(reportedFailedPaths()).toEqual(['.filo/themes/mine.json']);
    expect(unsavedComponentPayloads()).toEqual([]);
  });

  it('a theme or template delete that failed leaves nothing unsaved', async () => {
    installFiloMock({
      'theme:delete': () => ({ ok: false, code: 'EBUSY', error: 'locked' }),
      'templates:layout:delete': () => ({ ok: false, code: 'EBUSY', error: 'locked' }),
    });
    expect(await themeStore.deleteTheme(VAULT, 'mine')).toBe(false);
    await expect(deleteLayoutTemplate(VAULT, 't--abc.template.json')).rejects.toThrow();
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
  });

  it('a locked template save is kept for Retry', async () => {
    let locked = true;
    installFiloMock({ 'templates:layout:write': () => (locked ? { ok: false, code: 'EBUSY', error: 'locked' } : { ok: true }) });
    const template = { id: 'abc', name: 'T' } as unknown as LayoutTemplate; // allow-cast: only id and name reach the write
    await expect(saveLayoutTemplate(VAULT, template)).rejects.toThrow();
    expect(unsavedWork().failed).toHaveLength(1);
    locked = false;
    expect((await retryAllFailedWrites()).failed).toEqual([]);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
  });

  it("a note's exclusive create that failed leaves no failed mark behind", async () => {
    installFiloMock({ 'vault:create-file-text': () => ({ success: false, code: 'EACCES', error: 'denied' }) });
    await expect(noteStore.createExclusive('New.md', '# New\n')).rejects.toThrow();
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
  });
});
