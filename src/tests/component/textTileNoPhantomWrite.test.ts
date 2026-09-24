import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordingFilo,
  mountTextTile,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Audit-19 MD-2 — TextTile's onDestroy wrote the file on EVERY unmount (viewport
 * culling, LOD switch, board/tab switch), re-serialising untouched notes through
 * the editor: `_x_` became `*x*`, Setext became ATX, CRLF notes went mixed-EOL.
 * Unmount must write only when this view has unsaved work.
 */
const NOTE = 'Setext Title\n============\n\nSome _emphasis_ here.\n';

function type(m: Awaited<ReturnType<typeof mountTextTile>>, text: string): void {
  const ed = m.editor();
  ed.commands.focus('end');
  ed.commands.insertContent(text);
}

describe('TextTile unmount writes only unsaved work (MD-2)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('mount → unmount with no edit writes nothing', async () => {
    const fs = recordingFilo({ 'Note.md': NOTE });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    await m.unmount();
    await drainDebounce();
    expect(fs.writesTo('Note.md')).toEqual([]);
    expect(fs.files.get('Note.md')).toBe(NOTE);
  });

  it('an edit then an unmount inside the debounce writes exactly once, with the edit', async () => {
    const fs = recordingFilo({ 'Note.md': NOTE });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    type(m, 'Z');
    await m.unmount();
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBe(1);
    expect(writes[0].content).toContain('Z');
  });

  it('an edit that already autosaved is not written again on unmount', async () => {
    const fs = recordingFilo({ 'Note.md': NOTE });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    type(m, 'Z');
    await drainDebounce();
    expect(fs.writesTo('Note.md').length).toBe(1);
    await m.unmount();
    await drainDebounce();
    expect(fs.writesTo('Note.md').length).toBe(1);
  });

  it('a failed autosave is retried on unmount', async () => {
    const fs = recordingFilo({ 'Note.md': NOTE });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    fs.failWrites('Note.md', 'EBUSY');
    type(m, 'Z');
    await drainDebounce();
    expect(fs.writesTo('Note.md')).toEqual([]);
    fs.failWrites('Note.md', null);
    await m.unmount();
    await settle();
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBe(1);
    expect(writes[0].content).toContain('Z');
  });
});
