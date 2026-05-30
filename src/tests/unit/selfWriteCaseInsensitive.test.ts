import { describe, it, expect, beforeEach } from 'vitest';
import {
  markRecentSelfWrite,
  isRecentSelfWrite,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';

/**
 * Phase 4 — recent-self-write registry is routed through the shared
 * `vaultPath()` constructor, so the case-fold rule is unconditional (same
 * en-US lowercase normalisation `tagsStorage` uses). The original
 * Phase 3 / 3.4 implementation gated on `process.platform`; the platform
 * branches are gone now in favour of the unified `VaultPath` rule.
 *
 * The tradeoff: a hypothetical case-sensitive Linux vault that stores
 * both `Notes.md` and `notes.md` as distinct files would conflate them in
 * the self-write registry. That's accepted — every other vault-relative-
 * path map key in the codebase already collapses them (file tags, broken
 * refs, watcher suppression) and Filo's PKM target audience would never
 * intentionally create same-name-different-case siblings.
 */

describe('writeStateTracking — self-write case folding (Phase 4)', () => {
  beforeEach(() => {
    __clearRecentSelfWritesForTests();
  });

  it('marks and finds the same path with identical casing', () => {
    markRecentSelfWrite('Notes.md');
    expect(isRecentSelfWrite('Notes.md')).toBe(true);
  });

  it('strips Windows separators and leading slashes in the key', () => {
    markRecentSelfWrite('\\sub\\Notes.md');
    expect(isRecentSelfWrite('sub/Notes.md')).toBe(true);
    expect(isRecentSelfWrite('/sub/Notes.md')).toBe(true);
  });

  it('matches mixed-case lookups against the registered key on every platform', () => {
    markRecentSelfWrite('Notes.md');
    expect(isRecentSelfWrite('notes.md')).toBe(true);
    expect(isRecentSelfWrite('NOTES.MD')).toBe(true);
    expect(isRecentSelfWrite('Notes.MD')).toBe(true);
  });

  it('marking under one casing extends the TTL when re-marked under a different casing', () => {
    markRecentSelfWrite('sub/Notes.md');
    // A second call with different casing should land on the same key
    // (so the entry is extended, not duplicated). We can't observe the
    // map directly, but we can verify both lookups still hit.
    markRecentSelfWrite('Sub/NOTES.MD');
    expect(isRecentSelfWrite('sub/notes.md')).toBe(true);
    expect(isRecentSelfWrite('SUB/notes.md')).toBe(true);
  });
});
