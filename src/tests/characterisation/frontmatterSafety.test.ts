/**
 * Characterisation — a metadata change never breaks or deletes text Filo
 * can't model as properties.
 *
 * A vault-wide tag rename over a note whose `tags:` flow list wraps onto a
 * second line (Prettier writes these) leaves YAML that parses and keeps every
 * other tag. A note that opens with a paragraph between two `---` rules keeps
 * that paragraph when a tag is added: the change is refused and the user is
 * told why. A note whose block has a duplicate key shows its tags (the index
 * and the open note read the same keys), and a tag added to it is refused
 * without leaving a step to undo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import { renameTagEverywhere, openNoteFromSidebar, typeInTagRow, tagRowTags, errorToasts, closeModal, undoAvailable } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function frontmatterOf(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter block');
  const doc = parseDocument(m[1] ?? '', { uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(`frontmatter no longer parses:\n${m[1]}`);
  return doc.toJS() as Record<string, unknown>;
}

describe('vault-wide tag rename', () => {
  it('over a wrapped flow list leaves YAML that parses and keeps every other tag', async () => {
    const wrapped = '---\ntitle: Plan\ntags: [project, draft,\n  review]\nstatus: open\n---\nBody\n';
    const plain = '---\ntitle: Other\ntags: [draft]\n---\nText\n';
    const app = await startApp({ 'Plan.md': wrapped, 'Other.md': plain });

    await renameTagEverywhere(app, 'draft', 'final');
    await waitFor(() => app.read('Other.md').includes('final'), 'the rename on disk');
    await waitFor(() => !app.read('Plan.md').includes('draft'), 'the wrapped note renamed too');
    await closeModal();

    const fm = frontmatterOf(app.read('Plan.md'));
    expect(fm).toEqual({ title: 'Plan', tags: ['project', 'final', 'review'], status: 'open' });
    expect(app.read('Plan.md').endsWith('\nBody\n')).toBe(true);
  });
});

describe('a note that opens with text between two --- rules', () => {
  it('keeps that text when a tag is added, and says why the tag was not saved', async () => {
    const note = '---\nA paragraph between two rules\n---\nBody\n';
    const app = await startApp({ 'Rules.md': note });
    await openNoteFromSidebar(app, 'Rules.md');

    await typeInTagRow(app, 'work');
    await waitFor(() => errorToasts().some((t) => /can't read as properties/.test(t)), 'the refusal toast');
    await quiesce(800);
    expect(app.read('Rules.md')).toBe(note);
  });
});

describe('a note whose frontmatter has a duplicate key', () => {
  it('shows its tags when open, and a tag added is refused with the file left alone', async () => {
    const note = '---\ntitle: Plan\ntags: [work]\ntitle: Plan again\n---\nBody\n';
    const app = await startApp({ 'Dup.md': note });
    await openNoteFromSidebar(app, 'Dup.md');
    expect(tagRowTags(app)).toEqual(['work']);

    await typeInTagRow(app, 'extra');
    await waitFor(() => errorToasts().some((t) => /frontmatter is malformed/.test(t)), 'the refusal toast');
    await quiesce(800);
    expect(app.read('Dup.md')).toBe(note);
    expect(tagRowTags(app)).toEqual(['work']);
    // Nothing changed, so there is no step to undo.
    expect(undoAvailable(app)).toBe(false);
  });
});
