import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  scheduleConfigWrite,
  cancelAllPendingWrites,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type {
  MindMapBoard,
  ProjectSettings,
  WorkspaceState,
  WorkspaceLayout,
} from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Regression: vault-swap previously cleared in-memory write-tracking sets via
 * `resetWriteTracking()` but left the `pendingBoardWrites` Map and the
 * `pendingConfigWrite` timer untouched. If the user declined the "save before
 * opening?" dialog, those timers fired AFTER the new vault opened — their
 * closures wrote to the OLD vaultRoot.
 *
 * `cancelAllPendingWrites()` clears the timers so nothing leaks across the
 * vault boundary.
 *
 * Note (Phase 1 / CONSOLIDATION_PLAN_2026-05-25): tests in this file route
 * through `installFiloMock` / `restoreFiloDefault` from the shared helper
 * rather than deleting `window.filo` outright. `scheduleBoardWrite` queues
 * an async `markDirty` (via `withSentinelLock`) whose microtask body runs
 * AFTER the test function returns — a deleted `window.filo` at that point
 * would surface a `Cannot read properties of undefined (reading 'invoke')`
 * via the `dirtyFlag.mark` errorBus toast and trip the strict gate. The
 * shared default stub returns `undefined` for every channel, which
 * `assertIpcOk` accepts as a bare-value passthrough.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  installFiloMock(routes);
}

function makeBoardArgs() {
  return {
    vaultRoot: '/vault-old',
    boardPath: 'old.board.json',
    cached: {
      board: {
        id: 'mm', type: 'mindmap', name: 'Old', emoji: '',
        createdAt: 0, updatedAt: 0, settings: {},
        placements: {}, inlineTiles: {}, waypoints: [],
      } as unknown as MindMapBoard,
      tileDefs: {},
      connections: {},
      frames: [],
    } as BoardFileData,
  };
}

function makeConfigArgs() {
  return {
    vaultRoot: '/vault-old',
    settings: {} as ProjectSettings,
    theme: 'light',
    workspace: {} as WorkspaceState,
    layout: { type: 'leaf' } as unknown as WorkspaceLayout,
  };
}

describe('boardSaver — cancelAllPendingWrites', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites(); // safety net for any leaked timer between tests
    vi.useRealTimers();
    restoreFiloDefault();
  });

  it('cancels a queued board write so it never fires', () => {
    const boardSave = vi.fn(async () => null);
    installFiloStub({ 'board:save': boardSave });

    scheduleBoardWrite('mm', () => makeBoardArgs());

    // Cancel BEFORE the 300ms debounce fires.
    cancelAllPendingWrites();

    // Advance past the debounce window — the cancelled timer must not have fired.
    vi.advanceTimersByTime(1000);
    expect(boardSave).not.toHaveBeenCalled();
  });

  it('cancels the pending config-write timer', () => {
    const configSave = vi.fn(async () => null);
    installFiloStub({
      'config:save': configSave,
      'config:save-workspace': configSave,
    });

    scheduleConfigWrite(() => makeConfigArgs());

    cancelAllPendingWrites();
    vi.advanceTimersByTime(1000);

    expect(configSave).not.toHaveBeenCalled();
  });

  it('is idempotent — calling twice is safe', () => {
    installFiloStub({ 'board:save': async () => null });
    scheduleBoardWrite('mm', () => makeBoardArgs());
    expect(() => {
      cancelAllPendingWrites();
      cancelAllPendingWrites();
    }).not.toThrow();
  });

  it('after cancel, a fresh scheduleBoardWrite still works', () => {
    const boardSave = vi.fn(async () => null);
    installFiloStub({ 'board:save': boardSave });

    scheduleBoardWrite('mm', () => makeBoardArgs());
    cancelAllPendingWrites();

    // New scheduling against the new vault.
    scheduleBoardWrite('mm', () => ({
      ...makeBoardArgs(),
      vaultRoot: '/vault-new',
      boardPath: 'new.board.json',
    }));

    vi.advanceTimersByTime(1000);
    expect(boardSave).toHaveBeenCalledTimes(1);
    // The fresh schedule wrote against the NEW vaultRoot, not the cancelled one.
    expect(boardSave.mock.calls[0][0]).toBe('/vault-new');
  });
});
