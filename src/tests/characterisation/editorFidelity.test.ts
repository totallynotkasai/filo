/**
 * Characterisation — what is typed in a note reopens as typed, and editable.
 *
 * A note Filo writes must read back to the same note: otherwise it reopens
 * read-only (Filo won't write over what it can't keep). An empty checkbox
 * left after the last task, a bullet list turned into a checklist, and a
 * paragraph typed with leading spaces all used to reopen read-only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, reopenVault, type CharApp } from './harness/app';
import { $$, editors, openNoteFromSidebar, caretAfter, pressInEditor, typeKeys, leaveEditor } from './harness/actions';
import { documentBanners } from './harness/errorStates';

type Editor = ReturnType<typeof editors>[number];

afterEach(async () => {
  await stopApp();
});

function noteEditor(app: CharApp): Editor {
  const [ed] = editors($$(app.el, '.document-board')[0]);
  return ed;
}

async function reopenNote(app: CharApp, rel: string): Promise<Editor> {
  await reopenVault(app);
  await openNoteFromSidebar(app, rel);
  return noteEditor(app);
}

const body = (app: CharApp, rel: string): string => app.read(rel).replace(/^---\n[\s\S]*?\n---\n/, '');

describe('what is typed reopens as typed', () => {
  it('a checklist typed with "[ ] ", Enter after the last task, then a click away', async () => {
    const app = await startApp({ 'List.md': '---\ntitle: List\n---\nAbove\n' });
    await openNoteFromSidebar(app, 'List.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'Above');
    await pressInEditor(ed, 'Enter');
    await typeKeys(ed, '[ ] first task');
    await pressInEditor(ed, 'Enter');
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'List.md')).toBe('Above\n\n- [ ] first task\n- [ ] \n');

    const again = await reopenNote(app, 'List.md');
    expect(documentBanners(app)).toEqual([]);
    expect(again.isEditable).toBe(true);
    const items = again.getJSON().content?.[1]?.content ?? [];
    expect(items.map((i) => i.type)).toEqual(['taskItem', 'taskItem']);
  });

  it('Ctrl+Shift+9 on the middle bullet of a list makes the list a checklist', async () => {
    const app = await startApp({ 'Bullets.md': '---\ntitle: Bullets\n---\n- a\n- b\n- c\n' });
    await openNoteFromSidebar(app, 'Bullets.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'b');
    await pressInEditor(ed, '9', { ctrlKey: true, shiftKey: true, keyCode: 57 } as KeyboardEventInit);
    expect(ed.getJSON().content?.map((n) => n.type)).toEqual(['taskList']);
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'Bullets.md')).toBe('- [ ] a\n- [ ] b\n- [ ] c\n');

    const again = await reopenNote(app, 'Bullets.md');
    expect(documentBanners(app)).toEqual([]);
    expect(again.getJSON().content?.map((n) => n.type)).toEqual(['taskList']);
    expect(again.getText()).toContain('b');
  });

  it('a paragraph typed with four leading spaces', async () => {
    const app = await startApp({ 'Indent.md': '---\ntitle: Indent\n---\nAbove\n' });
    await openNoteFromSidebar(app, 'Indent.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'Above');
    await pressInEditor(ed, 'Enter');
    await typeKeys(ed, '    indented text');
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'Indent.md')).toBe('Above\n\n&#32;   indented text\n');

    const again = await reopenNote(app, 'Indent.md');
    expect(documentBanners(app)).toEqual([]);
    expect(again.isEditable).toBe(true);
    expect(again.getText()).toContain('    indented text');
  });
});
