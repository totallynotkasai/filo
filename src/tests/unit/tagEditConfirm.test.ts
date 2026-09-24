/**
 * Tags browser delete / rename use the in-app ConfirmDialog. The native
 * `confirm()` blocked the renderer event loop (and every debounced write with
 * it) and didn't say what the change would touch or that a merge is final.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { deleteTagWithConfirm, renameTagWithConfirm } from '@renderer/lib/tags/tagEditConfirm';

describe('Tags browser confirms', () => {
  let nativeConfirm: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.spyOn>;
  let rename: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    remove = vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockResolvedValue(undefined);
    rename = vi.spyOn(fileTagsStore, 'renameTagEverywhere').mockResolvedValue(undefined);
    vi.spyOn(fileTagsStore, 'filesForTag').mockReturnValue(['a.md', 'b.md', 'c.png']);
    vi.spyOn(fileTagsStore, 'getTilesWithTag').mockReturnValue([
      { id: 't1', type: 'link', title: 'x', tags: ['work'] },
    ]);
    vi.spyOn(fileTagsStore, 'allTagNames').mockReturnValue(['work', 'home', 'project', 'project/active']);
  });

  afterEach(() => {
    uiStore.closeConfirm();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function answer(ok: boolean): Promise<void> {
    await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
    const cfg = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    if (ok) cfg.onConfirm(false);
    else cfg.onCancel?.();
  }

  it('delete opens a danger confirm with the counts, never window.confirm', async () => {
    const done = deleteTagWithConfirm('work');
    await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
    const cfg = uiStore.confirmDialog!;
    expect(cfg.danger).toBe(true);
    expect(cfg.title).toBe('Delete tag "#work"?');
    expect(cfg.body).toContain('3 files and 1 tile');
    expect(cfg.confirmLabel).toBe('Delete tag');
    await answer(true);
    expect(await done).toBe(true);
    expect(remove).toHaveBeenCalledWith('work');
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('cancelling the delete runs no sweep', async () => {
    const done = deleteTagWithConfirm('work');
    await answer(false);
    expect(await done).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('a childless rename to a new name needs no confirm', async () => {
    expect(await renameTagWithConfirm('home', 'house')).toBe(true);
    expect(uiStore.confirmDialog).toBeNull();
    expect(rename).toHaveBeenCalledWith('home', 'house');
  });

  it('renaming into an existing tag warns that the merge cannot be undone', async () => {
    const done = renameTagWithConfirm('home', 'work');
    await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
    const cfg = uiStore.confirmDialog!;
    expect(cfg.title).toBe('Merge "#home" into "#work"?');
    expect(cfg.body).toMatch(/can't be undone/);
    expect(cfg.danger).toBe(true);
    await answer(false);
    expect(await done).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it('a rename with child tags lists them and runs only after Confirm', async () => {
    const done = renameTagWithConfirm('project', 'proj');
    await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
    expect(uiStore.confirmDialog!.body).toContain('project/active');
    await answer(true);
    expect(await done).toBe(true);
    expect(rename).toHaveBeenCalledWith('project', 'proj');
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});

describe('no native confirm() in the renderer', () => {
  it('src/renderer has zero confirm( calls outside comments', () => {
    const root = resolve(__dirname, '..', '..', 'renderer');
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|svelte)$/.test(p)) continue;
        readFileSync(p, 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
            // `confirm(` not preceded by an identifier char or `.` (so
            // openConfirm( / uiStore.confirmAsync( / a local `function confirm()` don't match).
            if (/(^|[^\w.$])confirm\(/.test(code) && !/function\s+confirm\(/.test(code) && !/^\s*confirm\(\);/.test(code)) {
              offenders.push(`${p}:${i + 1}`);
            }
          });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
