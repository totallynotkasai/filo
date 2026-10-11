import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { linksStore } from '@renderer/stores/links.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { encodeFiloLink } from '@renderer/schema/link';
import type { Project } from '@renderer/schema/index';

/**
 * Dedicated coverage for `links.svelte.ts`. Covers the filo://
 * link dispatch: non-filo URLs are passed through to the external handler, a
 * board-nav link opens the target tab (happy path), and a board-nav to a missing
 * board surfaces an error toast instead of navigating to nothing (failure path).
 */

function projectWithBoard(boardId: string): Project {
  return {
    boards: [{ id: boardId, name: 'Target', type: 'mindmap', emoji: '🗺️' }],
  } as unknown as Project;
}

describe('linksStore.handleLinkClick', () => {
  beforeEach(() => {
    // `navigateToBoard` reads the virtual project via `vaultStore.getData()`
    // (the vaultProject slice). Stub it to a project with one board.
    vi.spyOn(vaultStore, 'getData').mockReturnValue(projectWithBoard('b1'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for a non-filo URL (treated as external)', () => {
    expect(linksStore.handleLinkClick('https://example.com')).toBe(false);
    expect(linksStore.handleLinkClick('mailto:a@b.com')).toBe(false);
    expect(linksStore.handleLinkClick('not even a url')).toBe(false);
  });

  it('returns false for a malformed filo:// link', () => {
    expect(linksStore.handleLinkClick('filo://bogus/')).toBe(false);
  });

  it('a board-nav link opens the target board tab (happy path)', () => {
    const openSpy = vi.spyOn(tabStore, 'open').mockImplementation(() => undefined as never);
    const url = encodeFiloLink({ id: 'lnk', type: 'board-nav', targetBoardId: 'b1', label: '' });
    expect(linksStore.handleLinkClick(url)).toBe(true);
    expect(openSpy).toHaveBeenCalledWith('b1', 'Target', 'mindmap', '🗺️');
  });

  it('a board-nav to a MISSING board toasts an error instead of navigating (failure path)', () => {
    const openSpy = vi.spyOn(tabStore, 'open').mockImplementation(() => undefined as never);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const url = encodeFiloLink({ id: 'lnk', type: 'board-nav', targetBoardId: 'missing', label: '' });
    expect(linksStore.handleLinkClick(url)).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith('Board not found', 'error', 2000);
  });
});
