/**
 * Phase 4 / E4 — dev-time baseline tripwire. `assertBaselinesSeeded` warns
 * (never throws) when a loaded path is missing its drift baseline, turning the
 * F1 invariant into a runtime signal during development. These tests run under
 * vitest, where `import.meta.env.DEV` is true, so the guarded body executes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  noteBaseline,
  assertBaselinesSeeded,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';

describe('assertBaselinesSeeded (E4)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetBaselinesForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetBaselinesForTests();
    warn.mockRestore();
  });

  it('warns, naming the path(s) missing a baseline', () => {
    noteBaseline('A.board.json', 1, 10); // registry non-empty (a real load happened)
    assertBaselinesSeeded(['A.board.json', 'B.board.json'], 'board');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('B.board.json');
    expect(String(warn.mock.calls[0][0])).not.toContain('A.board.json');
  });

  it('does not warn when every path has a baseline', () => {
    noteBaseline('A.board.json', 1, 10);
    noteBaseline('B.board.json', 2, 20);
    assertBaselinesSeeded(['A.board.json', 'B.board.json'], 'board');
    expect(warn).not.toHaveBeenCalled();
  });

  it('short-circuits (no warn) when the registry is empty — e.g. a stubbed test load', () => {
    assertBaselinesSeeded(['A.board.json'], 'board');
    expect(warn).not.toHaveBeenCalled();
  });
});
