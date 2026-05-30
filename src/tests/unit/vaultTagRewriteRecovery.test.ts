import { describe, it, expect } from 'vitest';
import { hasPartialTagRewriteState } from '@renderer/lib/vault/tagRewriteSentinel';

/**
 * IMPL_PLAN_2026-05-26 / Item 4 — partial-rewrite state detection.
 *
 * The tag-rewrite "Discard" recovery path used to drop the sentinel
 * without reconciling .md files that had been partially rewritten before
 * the crash. `hasPartialTagRewriteState` is the seam the recovery
 * dialog uses to decide whether to surface the "Finalise & discard"
 * label instead of the bare "Discard plan" — and whether the cancel
 * handler should converge the rewrite forward before clearing the
 * breadcrumb. These tests pin the contract.
 */

interface TestMetadata {
  tags: readonly string[];
}

describe('hasPartialTagRewriteState', () => {
  it('returns false when no metadata is loaded', () => {
    expect(hasPartialTagRewriteState('new-tag', [])).toBe(false);
  });

  it('returns false when no file carries newName', () => {
    const metadata: TestMetadata[] = [
      { tags: ['old-tag', 'unrelated'] },
      { tags: ['another'] },
    ];
    expect(hasPartialTagRewriteState('new-tag', metadata)).toBe(false);
  });

  it('returns true when at least one file already carries newName', () => {
    const metadata: TestMetadata[] = [
      { tags: ['old-tag'] },
      { tags: ['new-tag'] }, // partial-rewrite witness
      { tags: ['old-tag'] },
    ];
    expect(hasPartialTagRewriteState('new-tag', metadata)).toBe(true);
  });

  it('returns true when every file carries newName (the user finished but the sentinel survived)', () => {
    const metadata: TestMetadata[] = [
      { tags: ['new-tag'] },
      { tags: ['new-tag', 'something-else'] },
    ];
    expect(hasPartialTagRewriteState('new-tag', metadata)).toBe(true);
  });

  it('returns false for removal sentinels (newName === null) regardless of metadata', () => {
    const metadata: TestMetadata[] = [
      { tags: ['obsolete'] },
      { tags: ['kept'] },
    ];
    // Removal sentinels can't be reliably classified as partial without
    // per-path commit status — the function returns false by design so
    // the existing Discard semantics persist for removals.
    expect(hasPartialTagRewriteState(null, metadata)).toBe(false);
  });

  it('accepts an iterable (not just an array)', () => {
    function* gen(): IterableIterator<TestMetadata> {
      yield { tags: ['a'] };
      yield { tags: ['target'] };
    }
    expect(hasPartialTagRewriteState('target', gen())).toBe(true);
  });

  it('short-circuits on first match', () => {
    let visited = 0;
    function* gen(): IterableIterator<TestMetadata> {
      visited += 1;
      yield { tags: ['target'] };
      visited += 1;
      yield { tags: ['target'] };
      visited += 1;
      yield { tags: ['target'] };
    }
    expect(hasPartialTagRewriteState('target', gen())).toBe(true);
    // Only the first entry of the generator was pulled.
    expect(visited).toBe(1);
  });
});

/**
 * Integration-shape coverage for the recovery dialog wiring. We don't
 * mount the full `openVault` flow (it requires a populated project,
 * theme registry, watcher, …); instead we reproduce the small piece of
 * the recovery handler logic and assert the resulting dialog state.
 */
describe('tag-rewrite recovery dialog — partial-state dispatch', () => {
  function simulateRecoveryDispatch(
    sentinel: { oldName: string; newName: string | null; plan: string[] },
    indexMetadata: TestMetadata[],
  ): {
    cancelLabel: string;
    bodyMentionsAlreadyRewritten: boolean;
    discardWillFinalise: boolean;
  } {
    const newTagPresent = hasPartialTagRewriteState(sentinel.newName, indexMetadata);
    const verb = sentinel.newName === null ? 'removal' : 'rename';
    const target = sentinel.newName === null
      ? `"${sentinel.oldName}"`
      : `"${sentinel.oldName}" → "${sentinel.newName}"`;
    const body = newTagPresent
      ? `Filo found an unfinished tag ${verb} (${target}) and some files have already been rewritten in the previous session. Resume to finish — Discard will finalise the rewrite so the vault doesn't split between the old and new tag.`
      : `Filo found an unfinished tag ${verb} (${target}) that didn't complete in the previous session. Resume rewriting ${sentinel.plan.length} file${sentinel.plan.length === 1 ? '' : 's'}?`;
    return {
      cancelLabel: newTagPresent ? 'Finalise & discard' : 'Discard plan',
      bodyMentionsAlreadyRewritten: body.includes('already been rewritten'),
      discardWillFinalise: newTagPresent,
    };
  }

  it('clean rename sentinel surfaces the "Discard plan" cancel label', () => {
    const result = simulateRecoveryDispatch(
      { oldName: 'old', newName: 'new', plan: ['a.md', 'b.md'] },
      // No file carries `new` yet — sweep crashed before any commit.
      [
        { tags: ['old'] },
        { tags: ['old', 'kept'] },
      ],
    );
    expect(result.cancelLabel).toBe('Discard plan');
    expect(result.bodyMentionsAlreadyRewritten).toBe(false);
    expect(result.discardWillFinalise).toBe(false);
  });

  it('partial-rewrite state surfaces the "Finalise & discard" label and warns the user', () => {
    const result = simulateRecoveryDispatch(
      { oldName: 'old', newName: 'new', plan: ['a.md', 'b.md', 'c.md'] },
      // First two .md files committed to `new` before the crash; the
      // third still carries `old`.
      [
        { tags: ['new'] },
        { tags: ['new'] },
        { tags: ['old'] },
      ],
    );
    expect(result.cancelLabel).toBe('Finalise & discard');
    expect(result.bodyMentionsAlreadyRewritten).toBe(true);
    expect(result.discardWillFinalise).toBe(true);
  });

  it('removal sentinel never opts into the finalise path (different mental model)', () => {
    const result = simulateRecoveryDispatch(
      { oldName: 'obsolete', newName: null, plan: ['x.md'] },
      // Even though one file still has the obsolete tag, removal
      // partial-state detection is out of scope for this fix — the
      // existing Discard semantics persist.
      [
        { tags: ['obsolete'] },
        { tags: ['kept'] },
      ],
    );
    expect(result.cancelLabel).toBe('Discard plan');
    expect(result.bodyMentionsAlreadyRewritten).toBe(false);
    expect(result.discardWillFinalise).toBe(false);
  });
});
