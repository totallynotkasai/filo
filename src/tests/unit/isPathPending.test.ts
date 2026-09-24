/**
 * Phase 4 / E3 — `isPathPending` is the single authority both external-change
 * reconcilers consult ("does any scheduler have a pending/in-flight write for
 * path P?"). The ledger path (board / frontmatter schedulers, which mark
 * `beginWrite` at schedule time) is already covered by cardPendingWriteClobber
 * + the board reconciler tests; these tests pin the markdown-gateway probe,
 * which closes the `manageSentinel: false` gap so a debounced editor-body
 * write that hasn't fired yet still reports as pending.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  scheduleMarkdownWrite,
  cancelMarkdownWrite,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { isPathPending, __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';

function args(relPath: string, callerId: string) {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: {},
    body: 'body',
    callerId,
    notePath: null,
  };
}

describe('isPathPending — markdown-gateway probe (E3)', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
  });

  it('reports a scheduled (not-yet-fired) markdown write as pending', () => {
    expect(isPathPending('Notes/a.md')).toBe(false);
    // A long delay keeps the timer armed (and not fired) for the assertion.
    scheduleMarkdownWrite(args('Notes/a.md', 'caller-1'), 100_000);
    expect(isPathPending('Notes/a.md')).toBe(true);
    // Cancel so the armed timer doesn't fire after the test.
    cancelMarkdownWrite('caller-1');
    expect(isPathPending('Notes/a.md')).toBe(false);
  });

  it('matches case-insensitively / slash-normalised (vaultPath identity)', () => {
    scheduleMarkdownWrite(args('Notes/Mixed.md', 'caller-2'), 100_000);
    // A watcher event differing only in case still resolves to pending.
    expect(isPathPending('notes/mixed.md')).toBe(true);
    cancelMarkdownWrite('caller-2');
  });

  it('does not report an unrelated path as pending', () => {
    scheduleMarkdownWrite(args('Notes/a.md', 'caller-3'), 100_000);
    expect(isPathPending('Notes/b.md')).toBe(false);
    cancelMarkdownWrite('caller-3');
  });
});
