/**
 * The words after a Retry and in the quit dialog say what is actually left:
 * - Retry's toast names what still isn't on disk, per kind. A board or note
 *   write is retried on every save; a theme or template save only from the
 *   toast; a held decision by no retry at all.
 * - When all the quit is waiting on is the user's decision, the dialog says
 *   so and offers to show the decisions, not to retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { quitDialog, retryResultText } from '@renderer/lib/vault/unsavedMessages';
import { handleFlushAndQuit, __resetQuitDrainingForTests } from '@renderer/lib/vault/handleFlushAndQuit';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultPath } from '@shared/vaultPath';

const keys = (...paths: string[]): Set<string> => new Set(paths.map((p) => vaultPath(p)));

describe('retryResultText', () => {
  it('everything saved: says so, offers no second retry', () => {
    expect(retryResultText([], 2)).toEqual({ text: 'Saved: 2 changes are on disk now.', type: 'success', retryAgain: false });
  });

  it('a board still locked: retried on every save, and asked about before leaving', () => {
    const r = retryResultText([{ path: 'Plan.board.json', cause: 'write-failed' }], 1);
    expect(r.type).toBe('error');
    expect(r.text).toContain('1 change saved.');
    expect(r.text).toContain('"Plan.board.json"');
    expect(r.text).toContain('tries again on every save');
    expect(r.text).not.toContain('only from here');
    expect(r.retryAgain).toBe(true);
  });

  it('a theme save: only a retry from here tries it again', () => {
    const r = retryResultText([{ path: '.filo/themes/dusk.json', cause: 'write-failed' }], 0, {
      componentKeys: keys('.filo/themes/dusk.json'),
    });
    expect(r.text).toContain('only from here');
    expect(r.text).not.toContain('every save');
    expect(r.text).not.toContain('at quit');
    expect(r.retryAgain).toBe(true);
  });

  it('a held decision: no retry helps; answer it', () => {
    const r = retryResultText([{ path: 'Card.md', cause: 'missing' }], 0, { decisionKeys: keys('Card.md') });
    expect(r.text).toContain('waiting for your decision');
    expect(r.text).not.toContain('no longer exists');
    expect(r.retryAgain).toBe(false);
  });

  it('a conflict counts as a decision even when it has no held entry', () => {
    const r = retryResultText([{ path: 'C.md', cause: 'conflict' }], 0);
    expect(r.text).toContain('waiting for your decision');
    expect(r.retryAgain).toBe(false);
  });
});

describe('quitDialog', () => {
  it('only decisions left: "Waiting for your decision"', () => {
    const d = quitDialog([{ path: 'Card.md', cause: 'conflict' }], 0, keys('card.md'));
    expect(d.decisionsOnly).toBe(true);
    expect(d.title).toBe('Waiting for your decision');
    expect(d.body).toContain('1 change is waiting for your decision.');
    expect(d.body).toContain('Show decisions');
  });

  it('decisions and a failed write: "Save failed", naming how many wait for a decision', () => {
    const d = quitDialog(
      [{ path: 'Card.md', cause: 'conflict' }, { path: 'Plan.board.json', cause: 'write-failed' }],
      0,
      keys('Card.md'),
    );
    expect(d.decisionsOnly).toBe(false);
    expect(d.title).toBe('Save failed');
    expect(d.body).toContain('1 of them is waiting for your decision');
    expect(d.body).toContain('Retry now');
  });

  it('no decisions: the dialog is as before', () => {
    const d = quitDialog([{ path: 'A.md', cause: 'write-failed' }], 0);
    expect(d.title).toBe('Save failed');
    expect(d.decisionsOnly).toBe(false);
  });
});

describe('quit with only a decision left', () => {
  beforeEach(() => __resetQuitDrainingForTests());
  afterEach(() => uiStore.closeConfirm());

  it('offers Show decisions instead of Retry now; it stays open and opens the list', async () => {
    const sent: string[] = [];
    const showDecisions = vi.fn();
    const retryFailed = vi.fn(async () => ({ failed: [] }));
    const done = handleFlushAndQuit({
      saveStateState: () => 'attention',
      save: async () => false,
      send: (c) => { if (c !== 'app:drain-heartbeat') sent.push(c); },
      reportError: () => {},
      retryFailed,
      describeUnsaved: async () => [{ path: 'Card.md', cause: 'conflict' }],
      heldDecisionPaths: () => ['Card.md'],
      showDecisions,
    });
    await new Promise((r) => setTimeout(r, 10));

    const d = uiStore.confirmDialog!;
    expect(d.title).toBe('Waiting for your decision');
    expect(d.secondaryAction?.label).toBe('Show decisions');
    d.secondaryAction!.onClick();
    uiStore.closeConfirm();
    await done;

    expect(showDecisions).toHaveBeenCalledTimes(1);
    expect(retryFailed).not.toHaveBeenCalled();
    expect(sent).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });
});
