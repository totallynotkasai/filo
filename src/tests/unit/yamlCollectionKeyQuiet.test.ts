/**
 * A collection used as a mapping key (`[a, b]: x`) is stringified by
 * `toJS()`. That is deliberate, so the `yaml` package's "Keys with collection
 * values will be stringified" warning is noise: in the app it was a
 * console.warn per read, and in CI it hid real warnings in stderr. Every
 * production `parseDocument` site passes `logLevel: 'error'`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseFrontmatterObject } from '@renderer/lib/vault/frontmatterRead';
import { parseMarkdownFile } from '@renderer/lib/editor/markdownSync';
import { patchFrontmatterSourceCst } from '@renderer/lib/vault/frontmatterCstModel';
import { rewriteTagInMarkdown } from '@renderer/lib/vault/tagRewriter';

const HOSTILE = '[a, b]: x\n{k: 1}: y\ntags:\n  - work';

describe('collection keys parse without a process warning', () => {
  afterEach(() => vi.restoreAllMocks());

  function spyWarnings(): { count: () => number } {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const isCollectionWarning = (args: unknown[]): boolean =>
      String(args[0]).includes('Keys with collection values');
    return {
      count: () =>
        emit.mock.calls.filter(isCollectionWarning).length + warn.mock.calls.filter(isCollectionWarning).length,
    };
  }

  it('frontmatterRead', () => {
    const w = spyWarnings();
    const fm = parseFrontmatterObject(HOSTILE);
    expect(fm.tags).toEqual(['work']);
    expect(w.count()).toBe(0);
  });

  it('markdownSync.parseMarkdownFile', () => {
    const w = spyWarnings();
    parseMarkdownFile(`---\n${HOSTILE}\n---\nBody\n`);
    expect(w.count()).toBe(0);
  });

  it('frontmatterCstModel.patchFrontmatterSourceCst', () => {
    const w = spyWarnings();
    patchFrontmatterSourceCst(HOSTILE, { tags: ['home'] });
    expect(w.count()).toBe(0);
  });

  it('tagRewriter', () => {
    const w = spyWarnings();
    rewriteTagInMarkdown(`---\n${HOSTILE}\n---\nBody\n`, 'work', 'job');
    expect(w.count()).toBe(0);
  });
});
