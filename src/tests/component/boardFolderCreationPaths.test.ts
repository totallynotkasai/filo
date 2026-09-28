/**
 * Every file a board creates goes in the folder `getActiveContentFolder`
 * resolves: with board-specific folders on, the board's own folder. Mounts
 * the real File and Audio tiles and the background image picker, and runs
 * the Kanban cover picker and OS-drop import, each with a board whose folder
 * is `Plan`, and checks where the copy (or recording) is written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const copyCalls: unknown[][] = [];
vi.mock('@renderer/lib/vault/vaultOperations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/vault/vaultOperations')>();
  return {
    ...actual,
    copyFileIntoVault: async (...args: unknown[]) => {
      copyCalls.push(args);
      const name = String(args[0]).split('/').pop() ?? '';
      const folder = String(args[2] ?? '');
      return { success: true, relativePath: folder ? `${folder}/${name}` : name };
    },
  };
});

import FileTileView from '@renderer/components/tiles/FileTile.svelte';
import AudioTileView from '@renderer/components/tiles/AudioTile.svelte';
import BackgroundImagePicker from '@renderer/components/shared/BackgroundImagePicker.svelte';
import { BOARD_SCOPE_KEY, resetActiveScope, setActiveScope, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { importKanbanFileTile } from '@renderer/lib/kanban/kanbanFileDropHandler';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { AudioTile, FileTile, KanbanBoard, Project } from '@renderer/schema/index';

const board = { id: 'b1', type: 'kanban', columns: [], settings: { defaultFolder: 'Plan' } };
const invokes: unknown[][] = [];
let instance: ReturnType<typeof mount> | null = null;

function scope(): BoardScope {
  return { board: { current: board, updateTile: vi.fn() } } as unknown as BoardScope;
}

function mountIn(component: Parameters<typeof mount>[0], props: Record<string, unknown>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(component, {
    target,
    props,
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, scope()]]),
  });
  flushSync();
  return target;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text);
  if (!btn) throw new Error(`no "${text}" button`);
  return btn;
}

beforeEach(() => {
  copyCalls.length = 0;
  invokes.length = 0;
  vaultStore.setPath('C:/vault');
  vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(
    { settings: { general: { boardFolders: true } } } as unknown as Project,
  );
  vi.spyOn(historyStore, 'execute').mockImplementation(() => undefined as never);
  installFiloMock((channel: string, ...args: unknown[]) => {
    invokes.push([channel, ...args]);
    if (channel === 'dialog:open-file') return ['D:/outside/pic.png'];
    if (channel === 'media:save-audio') return { success: true, path: 'Plan/rec.webm' };
    return { success: true };
  });
  setActiveScope(scope());
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.innerHTML = '';
  resetActiveScope();
  vaultStore.setPath('');
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe("files a board creates go in the board's folder", () => {
  it('File tile: a picked file is copied into the folder', async () => {
    const tile = { id: 'f1', type: 'file', filePath: '', fileName: '', fileExtension: '' } as unknown as FileTile;
    const root = mountIn(FileTileView, { tile });
    button(root, 'Choose File').click();
    await vi.waitFor(() => expect(copyCalls).toHaveLength(1));
    expect(copyCalls[0]).toEqual(['D:/outside/pic.png', 'C:/vault', 'Plan']);
  });

  it('background image: an upload is copied into the active board\'s folder', async () => {
    const onChange = vi.fn();
    const root = mountIn(BackgroundImagePicker, { value: '', onChange });
    button(root, 'Upload Image').click();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('Plan/pic.png'));
    expect(copyCalls[0]).toEqual(['D:/outside/pic.png', 'C:/vault', 'Plan']);
  });

  it('Kanban cover image: copied into the folder', async () => {
    const writer = makeKanbanFrontmatterWriter({
      getBoard: () => board as unknown as KanbanBoard,
      getAllTilesById: () => ({}),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
    await writer.pickCoverImageForTile('t1');
    expect(copyCalls[0]).toEqual(['D:/outside/pic.png', 'C:/vault', 'Plan']);
  });

  it('Kanban OS drop: the import copies into the folder it is given', async () => {
    await importKanbanFileTile({
      type: 'image',
      tileId: 't1',
      sourcePath: 'D:/outside/pic.png',
      fileName: 'pic.png',
      vaultRoot: 'C:/vault',
      destFolder: 'Plan',
      allTilesById: {},
      refreshTree: async () => {},
    });
    expect(copyCalls[0]).toEqual(['D:/outside/pic.png', 'C:/vault', 'Plan']);
  });

  it('Audio tile: a recording is saved into the folder', async () => {
    let recorder: { stop: () => void } | null = null;
    class FakeRecorder {
      static isTypeSupported = (): boolean => false;
      mimeType = 'audio/webm';
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        this.state = 'recording';
        recorder = { stop: () => this.stop() };
      }
      stop(): void {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });

    const tile = { id: 'a1', type: 'audio', src: '' } as unknown as AudioTile;
    const root = mountIn(AudioTileView, { tile });
    button(root, 'Record Audio').click();
    await vi.waitFor(() => expect(recorder).not.toBeNull());
    recorder!.stop();
    await vi.waitFor(() => expect(invokes.some(([c]) => c === 'media:save-audio')).toBe(true));
    const save = invokes.find(([c]) => c === 'media:save-audio')!;
    expect(save[1]).toBe('C:/vault');
    expect(save[4]).toBe('Plan');
    vi.unstubAllGlobals();
  });
});
