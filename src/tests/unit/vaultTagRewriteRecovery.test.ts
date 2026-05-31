import { describe, it, expect } from 'vitest';
import {
  hasPartialTagRewriteState,
  hasPartialTagRemovalState,
} from '@renderer/lib/vault/tagRewriteSentinel';

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
  // Mirrors the dispatch in stores/vault.svelte.ts: renames classify partial
  // state from the index; removals classify from the sentinel's recorded
  // `committedPaths` (6.3).
  function simulateRecoveryDispatch(
    sentinel: { oldName: string; newName: string | null; plan: string[]; committedPaths?: string[] },
    indexMetadata: TestMetadata[],
  ): {
    cancelLabel: string;
    partialDetected: boolean;
    bodyWarnsOfSplit: boolean;
  } {
    const { oldName, newName, plan, committedPaths = [] } = sentinel;
    const partialDetected =
      newName === null
        ? hasPartialTagRemovalState(committedPaths)
        : hasPartialTagRewriteState(newName, indexMetadata);
    const verb = newName === null ? 'removal' : 'rename';
    const target = newName === null ? `"${oldName}"` : `"${oldName}" → "${newName}"`;
    const partialBody =
      newName === null
        ? `Filo found an unfinished tag removal (${target}) — the tag was already stripped from some files in the previous session. Resume to finish — Discard will finalise the removal so the vault doesn't split between files that still carry the tag and files that don't.`
        : `Filo found an unfinished tag rename (${target}) and some files have already been rewritten in the previous session. Resume to finish — Discard will finalise the rewrite so the vault doesn't split between the old and new tag.`;
    const body = partialDetected
      ? partialBody
      : `Filo found an unfinished tag ${verb} (${target}) that didn't complete in the previous session. Resume rewriting ${plan.length} file${plan.length === 1 ? '' : 's'}?`;
    return {
      cancelLabel: partialDetected ? 'Finalise & discard' : 'Discard plan',
      partialDetected,
      bodyWarnsOfSplit: body.includes("doesn't split"),
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
    expect(result.bodyWarnsOfSplit).toBe(false);
    expect(result.partialDetected).toBe(false);
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
    expect(result.bodyWarnsOfSplit).toBe(true);
    expect(result.partialDetected).toBe(true);
  });

  it('clean removal sentinel (nothing committed) surfaces the "Discard plan" label', () => {
    const result = simulateRecoveryDispatch(
      // committedPaths empty ⇒ the sweep crashed before stripping any file;
      // every planned file still carries the tag (consistent pre-removal
      // state), so plain Discard is honest.
      { oldName: 'obsolete', newName: null, plan: ['x.md', 'y.md'], committedPaths: [] },
      [
        { tags: ['obsolete'] },
        { tags: ['obsolete'] },
      ],
    );
    expect(result.cancelLabel).toBe('Discard plan');
    expect(result.partialDetected).toBe(false);
  });

  it('partial removal (some files stripped) surfaces "Finalise & discard" (6.3)', () => {
    const result = simulateRecoveryDispatch(
      // committedPaths records x.md was stripped before the crash; y.md still
      // carries the tag ⇒ the vault is split, so recovery must converge
      // forward instead of plain-discarding the breadcrumb.
      { oldName: 'obsolete', newName: null, plan: ['x.md', 'y.md'], committedPaths: ['x.md'] },
      [
        { tags: ['obsolete'] }, // y.md still tagged
      ],
    );
    expect(result.cancelLabel).toBe('Finalise & discard');
    expect(result.bodyWarnsOfSplit).toBe(true);
    expect(result.partialDetected).toBe(true);
  });
});
