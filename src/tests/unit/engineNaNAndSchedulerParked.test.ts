import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { valuesEqual } from '@renderer/lib/vault/frontmatterEngine';
import { diffToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { patchFrontmatterSourceCst } from '@renderer/lib/vault/frontmatterCstModel';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import { writeBoardFile, setBoardExternalEditHandler } from '@renderer/lib/boards/boardWriteScheduler';
import {
  noteBaseline,
  getBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-17 Phase 5 — narrow-window hardening + engine edges.
 *
 * Each describe is bite-verified against the pre-fix code (temp-revert the named
 * fix → the block goes red).
 */

describe('Audit-17 5.1 — NaN equality (no churn on untouched `.nan` keys)', () => {
  it('valuesEqual treats NaN === NaN (and only NaN)', () => {
    expect(valuesEqual(NaN, NaN)).toBe(true);
    expect(valuesEqual(NaN, 5)).toBe(false);
    expect(valuesEqual(5, NaN)).toBe(false);
    // NaN nested in an array / object is equal element-wise.
    expect(valuesEqual([NaN, 1], [NaN, 1])).toBe(true);
    expect(valuesEqual({ a: NaN }, { a: NaN })).toBe(true);
    expect(valuesEqual({ a: NaN }, { a: 1 })).toBe(false);
  });

  it('diffToFrontmatterDelta does not flag an untouched `.nan` key as changed', () => {
    // valuesShallowEqual (private) is exercised through the popup diff: an
    // unchanged NaN value must produce an EMPTY delta. Pre-fix (NaN !== NaN) it
    // was emitted as a `set`, re-serialising the key on every unrelated edit.
    const delta = diffToFrontmatterDelta({ score: NaN, title: 'x' }, { score: NaN, title: 'x' });
    expect(delta.set).toEqual({});
    expect(delta.unset).toEqual([]);
    // A genuine change still surfaces.
    const changed = diffToFrontmatterDelta({ score: NaN }, { score: 1 });
    expect(changed.set).toEqual({ score: 1 });
  });

  it('CST engine byte-preserves an untouched non-canonical `.NaN` scalar', () => {
    // The source spelling `.NaN` parses to NaN; with the fix the key is
    // UNCHANGED (NaN === NaN) and spliced verbatim. Pre-fix it was "changed" and
    // re-serialised to the canonical `.nan`, mutating an untouched key's bytes.
    const src = 'score: .NaN\ntitle: x';
    const out = patchFrontmatterSourceCst(src, { score: NaN, title: 'y' });
    expect(out).not.toBeNull();
    expect(out).toContain('score: .NaN');
    expect(out).toContain('title: y');
  });
});

describe('Audit-17 5.2 — CST engine refuses a touched explicit `!!tag` key', () => {
  it('a CHANGED tagged scalar routes to the full-dump fallback (returns null)', () => {
    // priority is `!!int 5`; changing it to 10 would value-splice and leave the
    // tag → `priority: !!int 10` (corruption). The engine must refuse → null.
    const src = 'priority: !!int 5\ntitle: hello';
    const out = patchFrontmatterSourceCst(src, { priority: 10, title: 'hello' });
    expect(out).toBeNull();
  });

  it('an UNTOUCHED tagged scalar is byte-preserved (only the sibling rewritten)', () => {
    const src = 'priority: !!int 5\ntitle: hello';
    const out = patchFrontmatterSourceCst(src, { priority: 5, title: 'world' });
    expect(out).not.toBeNull();
    expect(out).toContain('priority: !!int 5');
    expect(out).toContain('title: world');
  });

  it('a DELETED tagged key routes to the full-dump fallback (returns null)', () => {
    const src = 'priority: !!int 5\ntitle: hello';
    const out = patchFrontmatterSourceCst(src, { title: 'hello' });
    expect(out).toBeNull();
  });
});

describe('Audit-17 5.5 — scheduler.hasParked sees parked fires; hasPendingTimer does not', () => {
  function makeScheduler() {
    return createScheduler<{ path: string }>({
      name: 'test',
      debounceMs: 1,
      performWrite: async () => {},
      getSentinelInfo: () => ({ vaultRoot: undefined, path: undefined }),
    });
  }

  it('hasParked matches a parked fire by key while hasPendingTimer stays blind to it', () => {
    const s = makeScheduler();
    const release = s.__parkForTests('caller-1');
    expect(s.hasParked((info) => info.key === 'caller-1')).toBe(true);
    expect(s.hasParked((info) => info.key === 'other')).toBe(false);
    // P2.5 contract preserved: armed-timer-only probe never sees the parked fire.
    expect(s.hasPendingTimer(() => true)).toBe(false);
    release();
    expect(s.hasParked(() => true)).toBe(false);
  });
});

describe('Audit-17 5.4 — board post-write baseline keeps prior on a foreign-size stat', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    setBoardExternalEditHandler(null);
  });
  afterEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    setBoardExternalEditHandler(null);
    restoreFiloDefault();
  });

  it('a post-write stat whose size differs from the bytes written does NOT stamp the baseline', async () => {
    const boardPath = 'Boards/Plan.board.json';
    // Seed a baseline so the pre-write drift check runs and matches (no drift).
    noteBaseline(boardPath, 1000, 100);

    let statCall = 0;
    installFiloMock((channel: string) => {
      if (channel === 'vault:stat') {
        statCall++;
        // 1st = pre-write drift stat: matches baseline → no drift.
        if (statCall === 1) return { ok: true, success: true, mtimeMs: 1000, size: 100 };
        // 2nd = post-write stat: a FOREIGN write of a different size landed in
        // the save→stat gap. 5.4 must reject it (size != bytes we wrote).
        return { ok: true, success: true, mtimeMs: 2000, size: 999_999 };
      }
      if (channel === 'board:save') return { ok: true, success: true };
      return { ok: true, success: true };
    });

    await writeBoardFile('/vault', boardPath, {
      version: 7,
      tileDefs: {},
      board: { type: 'kanban', id: 'b1' },
    } as never);

    // Foreign size rejected → prior baseline kept (DI-14), NOT poisoned to the
    // foreign (mtime,size). Pre-fix the post-write stat was stamped unconditionally.
    expect(getBaseline(boardPath)).toEqual({ mtimeMs: 1000, size: 100 });
  });
});
