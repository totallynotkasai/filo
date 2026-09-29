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
const NOTE = '---\ntitle: Wrapped\n---\nIntro\n\nA paragraph that is\nhard-wrapped across lines.\n';

describe('the read-only banner names what would change', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('names the first changed line, counted in the whole file', async () => {
    recordingFilo({ 'Wrapped.md': NOTE });
    const m = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    const text = m.target.querySelector('.readonly-banner .readonly-text')?.textContent ?? '';
    expect(text).toContain('Line 6 would change from “A paragraph that is” to “A paragraph that is hard-wrapped across lines.”');
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
    expect(textarea?.value).toContain('hard-wrapped');
    await settle();
    const selected = textarea!.value.slice(textarea!.selectionStart, textarea!.selectionEnd);
    expect(selected).toBe('A paragraph that is');
    await m.unmount();
  });
});
