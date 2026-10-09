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
import { $$, editors, openNoteFromSidebar, caretAfter, caretBefore, pressInEditor, typeKeys, leaveEditor, chooseTextStyle } from './harness/actions';
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

describe('lines written one per thought, and blank lines', () => {
  // A note from Keep or an agent: one paragraph whose lines are joined by single newlines.
  const STATS = 'Physical\nStrength - raw power\nEndurance - stamina\n';

  it('Enter at the end of a line opens a new line there; what is typed lands on it', async () => {
    const app = await startApp({ 'Stats.md': `---\ntitle: Stats\n---\n${STATS}` });
    await openNoteFromSidebar(app, 'Stats.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'raw power');
    await pressInEditor(ed, 'Enter');
    await typeKeys(ed, 'Speed - movement');
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'Stats.md')).toBe('Physical\nStrength - raw power\n\nSpeed - movement\n\nEndurance - stamina\n');

    const again = await reopenNote(app, 'Stats.md');
    expect(documentBanners(app)).toEqual([]);
    expect(again.isEditable).toBe(true);
  });

  it('Heading 3 from the toolbar on one line changes that line alone', async () => {
    const app = await startApp({ 'Stats.md': `---\ntitle: Stats\n---\n${STATS}` });
    await openNoteFromSidebar(app, 'Stats.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'Phys');
    await chooseTextStyle(app, 'Heading 3');
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'Stats.md')).toBe('### Physical\n\nStrength - raw power\nEndurance - stamina\n');

    const again = await reopenNote(app, 'Stats.md');
    expect(documentBanners(app)).toEqual([]);
    expect(again.getJSON().content?.map((n) => n.type)).toEqual(['heading', 'paragraph']);
  });

  it('"- " typed at the start of one line makes that line a list item alone, and the note reopens editable as it was saved', async () => {
    const app = await startApp({ 'Stats.md': `---\ntitle: Stats\n---\n${STATS}` });
    await openNoteFromSidebar(app, 'Stats.md');
    const ed = noteEditor(app);
    await caretBefore(ed, 'Strength');
    await typeKeys(ed, '- ');
    await leaveEditor(ed);
    await quiesce();
    expect(body(app, 'Stats.md')).toBe('Physical\n\n- Strength - raw power\n\nEndurance - stamina\n');
    const saved = app.read('Stats.md');

    const again = await reopenNote(app, 'Stats.md');
    await quiesce();
    expect(documentBanners(app)).toEqual([]);
    expect(again.isEditable).toBe(true);
    expect(again.getJSON().content?.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
    expect(app.read('Stats.md')).toBe(saved);
  });

  it('blank lines typed after the last line are there when the note reopens, and reopening writes nothing', async () => {
    const app = await startApp({ 'End.md': '---\ntitle: End\n---\nLast line\n' });
    await openNoteFromSidebar(app, 'End.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'Last line');
    await pressInEditor(ed, 'Enter');
    await pressInEditor(ed, 'Enter');
    await leaveEditor(ed);
    await quiesce();
    const saved = app.read('End.md');
    expect(body(app, 'End.md')).toBe('Last line\n\n\n\n');

    const again = await reopenNote(app, 'End.md');
    await quiesce();
    expect(documentBanners(app)).toEqual([]);
    expect(again.getJSON().content?.map((n) => n.content?.length ?? 0)).toEqual([1, 0, 0]);
    expect(app.read('End.md')).toBe(saved);
  });
});
