import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordingFilo,
  mountDocumentEditor,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

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
    let textarea: HTMLTextAreaElement | null = null;
    for (let i = 0; i < 50 && !textarea?.value; i++) {
      await settle();
      textarea = m.target.querySelector('textarea.raw-text');
    }
    expect(textarea?.value).toContain('<!-- a comment -->');
    await settle();
    const selected = textarea!.value.slice(textarea!.selectionStart, textarea!.selectionEnd);
    expect(selected).toBe('A paragraph with a <!-- a comment --> comment.');
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
