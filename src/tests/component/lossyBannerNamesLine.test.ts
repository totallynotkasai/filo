import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordingFilo,
  mountDocumentEditor,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';
import { loadedRawView, selectedText } from './helpers/rawView';

/**
 * A note Filo can't save without changing it opens read-only. The banner says
 * which line would change, and Edit in Raw view opens the whole file with
 * that line selected, so the user can fix it by hand instead of letting Take
 * ownership rewrite it.
 */
const NOTE = '---\ntitle: Wrapped\n---\nIntro\n\nA paragraph with a <!-- a comment --> comment.\n';

describe('the read-only banner names what would change', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('names the first changed line, counted in the whole file', async () => {
    recordingFilo({ 'Wrapped.md': NOTE });
    const m = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    const text = m.target.querySelector('.readonly-banner .readonly-text')?.textContent ?? '';
    expect(text).toContain('Line 6 would change from “A paragraph with a <!-- a comment --> comment.” to “A paragraph with a  comment.”');
    await m.unmount();
  });

  it('Edit in Raw view opens the raw view with that line selected', async () => {
    recordingFilo({ 'Wrapped.md': NOTE });
    const m = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    const button = [...m.target.querySelectorAll<HTMLButtonElement>('.readonly-banner .readonly-action')].find(
      (b) => b.textContent?.trim() === 'Edit in Raw view',
    );
    expect(button).toBeTruthy();
    button!.click();
    const field = await loadedRawView(m.target);
    expect(field.state.doc.toString()).toContain('<!-- a comment -->');
    await settle();
    expect(selectedText(field)).toBe('A paragraph with a <!-- a comment --> comment.');
    expect(field.hasFocus).toBe(true);
    // The line stays marked once the selection moves on, until it is edited.
    const named = (): string[] => [...m.target.querySelectorAll('.cm-filo-named-line')].map((l) => l.textContent ?? '');
    expect(named()).toEqual(['A paragraph with a <!-- a comment --> comment.']);
    field.dispatch({ selection: { anchor: 0 } });
    await settle();
    expect(named()).toHaveLength(1);
    const line = field.state.doc.line(6);
    field.dispatch({ changes: { from: line.to, insert: ' Edited.' }, userEvent: 'input.type' });
    await settle();
    expect(named()).toEqual([]);
    await m.unmount();
  });

  it('a change that only adds a blank line names the line it would go above', async () => {
    // A tight list mixing bullets and checklist items: Filo writes it as two.
    recordingFilo({ 'Mixed.md': '---\ntitle: Mixed\n---\nIntro\n\n- a\n- [ ] b\n' });
    const m = await mountDocumentEditor({ docPath: 'Mixed.md' });
    const text = m.target.querySelector('.readonly-banner .readonly-text')?.textContent ?? '';
    expect(text).toContain('Saving would add a blank line above line 7');
    await m.unmount();
  });

  it('a Keep note with a list straight under its text opens editable, with no banner', async () => {
    recordingFilo({ 'Keep.md': 'Todo:\n- [ ] one\n- [x] two\n' });
    const m = await mountDocumentEditor({ docPath: 'Keep.md' });
    expect(m.target.querySelector('.readonly-banner')).toBeNull();
    expect(m.editor().isEditable).toBe(true);
    await m.unmount();
  });
});
