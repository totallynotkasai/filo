import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * Phase 7.6 — `DocumentState.body` is body-only by contract; frontmatter is
 * held separately in the store's frontmatterCache. DocumentEditor.hydrateFromDisk
 * strips the fence correctly today, but a regression that fed a full file
 * (frontmatter + body) into updateContent would double the frontmatter on the
 * next serialize. This dev-only tripwire surfaces that loudly in dev/tests.
 */
function open(title: string): void {
  documentStore.loadDocument({
    filename: `${title}.md`,
    title,
    body: '',
    htmlContent: '',
    richText: [],
  });
}

describe('documentStore.updateContent body-only tripwire (Phase 7.6)', () => {
  beforeEach(() => documentStore.clear());
  afterEach(() => vi.restoreAllMocks());

  it('logs an error in dev when markdownBody carries a frontmatter block', () => {
    open('d');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    documentStore.updateContent('d.md', '<p>x</p>', '---\ntitle: X\n---\nbody', 'w');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('body-only');
  });

  it('does not log for a normal body-only string', () => {
    open('d');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    documentStore.updateContent('d.md', '<p>x</p>', 'just body text', 'w');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not log for a body that merely starts with a thematic break', () => {
    open('d');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Leading horizontal rule with no closing fence → not a frontmatter block.
    documentStore.updateContent('d.md', '<p>x</p>', '---\n\nReal content, no closing fence', 'w');
    expect(spy).not.toHaveBeenCalled();
  });

  it('still applies the content update (tripwire is non-fatal)', () => {
    open('d');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    documentStore.updateContent('d.md', '<p>x</p>', '---\ntitle: X\n---\nbody', 'w');
    // The (malformed) body is still stored — the guard warns, it doesn't block.
    expect(documentStore.getDocument('d.md')?.htmlContent).toBe('<p>x</p>');
  });
});
