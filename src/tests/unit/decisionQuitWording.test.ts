/**
 * A board changed outside Filo (Reload / Keep local) and a raw view's
 * conflict banner are questions for the user, like a note's conflict: no
 * retry saves them. So the quit dialog says it is waiting for a decision,
 * names what each one waits on without blaming another program for holding
 * the file, and speaks of files, not notes. A quit with only such a board
 * left reaches that dialog at once, without waiting out the prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { quitDialog, leaveVaultDialog, type UnsavedItem } from '@renderer/lib/vault/unsavedMessages';
import { handleFlushAndQuit, __resetQuitDrainingForTests } from '@renderer/lib/vault/handleFlushAndQuit';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultPath } from '@shared/vaultPath';
import {
  scheduleBoardWrite,
  flushAllScheduledBoards,
  setBoardExternalEditHandler,
} from '@renderer/lib/boards/boardWriteScheduler';
import { releaseBoardDrift } from '@renderer/lib/boards/boardDriftHold';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import {
  __resetDirtyTrackingForTests,
  hasFailedWrites,
  isUnsavedWorkEmpty,
  unsavedWork,
} from '@renderer/lib/boards/writeStateTracking';
import { resolveBoardDrift } from '@renderer/stores/boardDrift';
import { heldDecisions } from '@renderer/stores/heldDecisions';
import { describeUnsaved } from '@renderer/stores/unsavedRescue';
import type { BoardFileData } from '@renderer/lib/boards/tileDefBuilder';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const keys = (...paths: string[]): Set<string> => new Set(paths.map((p) => vaultPath(p)));

const BOARD: UnsavedItem = { path: 'Plan.board.json', cause: 'board-drift' };
const RAW: UnsavedItem = { path: 'Plan.md', cause: 'raw-conflict' };

describe('quitDialog with a board drift or a raw-view conflict', () => {
  it('only a board drift held: waiting for a decision, Show decisions, and says what it waits on', () => {
    const d = quitDialog([BOARD], 0, keys('Plan.board.json'));
    expect(d.decisionsOnly).toBe(true);
    expect(d.title).toBe('Waiting for your decision');
    expect(d.body).toContain('Plan.board.json: changed outside Filo, waiting for Reload or Keep local');
    expect(d.body).toContain('Show decisions');
    expect(d.body).not.toContain('OneDrive');
    expect(d.body).not.toContain('holding it');
    expect(d.body).toContain('each unsaved file');
    expect(d.body).not.toContain('unsaved note');
  });

  it('only a raw-view conflict held: waiting for a decision, worded as an edit made as text', () => {
    const d = quitDialog([RAW], 0, keys('Plan.md'));
    expect(d.decisionsOnly).toBe(true);
    expect(d.title).toBe('Waiting for your decision');
    expect(d.body).toContain('Plan.md: changed while you were editing it as text');
    expect(d.body).not.toContain('another program');
    expect(d.body).not.toContain('OneDrive');
  });

  it('a board drift and a failed note write: Save failed, and one of them waits for a decision', () => {
    const d = quitDialog([BOARD, { path: 'Card.md', cause: 'write-failed' }], 0, keys('Plan.board.json'));
    expect(d.decisionsOnly).toBe(false);
    expect(d.title).toBe('Save failed');
    expect(d.body).toContain('1 of them is waiting for your decision');
    expect(d.body).toContain('Plan.board.json: changed outside Filo, waiting for Reload or Keep local');
  });

  it('the leave dialog speaks of files too', () => {
    expect(leaveVaultDialog([BOARD], 'close').detail).toContain('keeps a copy of each unsaved file');
  });
});

describe('quitting with only a held board drift', () => {
  const PATH = 'plan.board.json';

  beforeEach(() => {
    __resetQuitDrainingForTests();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    installFiloMock((channel: string) => (channel === 'vault:stat' ? { success: true, mtimeMs: 2000, size: 50 } : { success: true }));
    noteBaseline(PATH, 1000, 200);
    setBoardExternalEditHandler((path) => resolveBoardDrift(path));
  });

  afterEach(() => {
    uiStore.closeConfirm();
    releaseBoardDrift(PATH);
    setBoardExternalEditHandler(null);
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('reaches the decision dialog without waiting for the prompt, and raises no failure toast', async () => {
    const cached = {
      board: { id: 'b', type: 'mindmap', name: 'Plan', settings: {}, placements: {}, inlineTiles: {}, waypoints: [] },
      tileDefs: {},
      connections: {},
      frames: [],
    } as unknown as BoardFileData;
    scheduleBoardWrite('b', () => ({ vaultRoot: '/v', boardPath: PATH, cached }));
    const started = Date.now();
    const done = handleFlushAndQuit({
      saveStateState: () => 'saved',
      save: async () => (await flushAllScheduledBoards(() => null)).failed.length === 0 && !hasFailedWrites(),
      send: () => {},
      reportError: () => {},
      describeUnsaved: () => describeUnsaved(),
      heldDecisionPaths: () => heldDecisions().map((d) => d.relPath()),
      nothingUnsaved: () => isUnsavedWorkEmpty(unsavedWork()),
      showDecisions: () => {},
    });

    const deadline = Date.now() + 2000;
    while (!uiStore.confirmDialog && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const d = uiStore.confirmDialog;
    expect(d?.title).toBe('Waiting for your decision');
    expect(d?.body).toContain('plan.board.json');
    expect(d?.secondaryAction?.label).toBe('Show decisions');
    expect(Date.now() - started).toBeLessThan(2000);
    // The question is the only notice about the board.
    expect(uiStore.toasts.filter((t) => t.type === 'error')).toEqual([]);
    expect(uiStore.toasts.filter((t) => t.text.includes('was changed outside Filo'))).toHaveLength(1);

    d!.onCancel?.();
    uiStore.closeConfirm();
    await done;
  });
});
