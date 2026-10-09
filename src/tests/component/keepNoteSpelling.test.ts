import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  drainUntilWritten,
  recordingFilo,
  mountDocumentEditor,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Typing in a note another app wrote changes only what was typed, plus the
 * spelling Filo can't keep: the blank line under the frontmatter, wiki links,
 * callouts and bracketed markers stay as the file has them.
 */
describe('an edit keeps what the file already says', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('the blank line after the frontmatter, wiki links and a callout survive typing', async () => {
    const note = '---\ntitle: Obsidian\n---\n\n> [!note] Heads up\n> body\n\nSee [[Page]] and [TODO] x\n';
    const fs = recordingFilo({ 'Obsidian.md': note });
    const m = await mountDocumentEditor({ docPath: 'Obsidian.md' });
    expect(m.target.querySelector('.readonly-banner')).toBeNull();
    m.editor().commands.focus('end');
    m.editor().commands.insertContent(' done');
    await settle();
    await drainUntilWritten(fs, 'Obsidian.md');
    expect(fs.files.get('Obsidian.md')).toBe(note.replace('[TODO] x\n', '[TODO] x done\n'));
    await m.unmount();
  });
});
