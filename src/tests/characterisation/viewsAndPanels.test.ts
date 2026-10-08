/**
 * Characterisation — the Mind Map, Documents and the interface (Audit-29
 * Phase 4), as a user meets them:
 * - folding a frame hides the frames inside it too;
 * - the Waypoints panel stays hidden until the board has a waypoint;
 * - Ctrl and + on the number pad, and Ctrl+Shift+=, zoom a note in, and the
 *   zoom keys work in the Raw view; a zoomed note on a laptop is clear of
 *   the docked sidebar;
 * - a read-only note's banner names the change that makes it read-only, and
 *   Take ownership lists it first;
 * - Spelling off reaches a task's title box and notes box;
 * - closing a split pane over a Raw view whose text can't be saved asks;
 * - Escape: the sidebar's clears its selection and leaves Search open, and
 *   the Mind Map's clears its selection;
 * - a Kanban card: Ctrl+A, its menu's order and Delete from vault…, a due time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, recoveryCopies } from './harness/app';
import {
  addKanbanCard,
  addKanbanColumn,
  addMindMapTextTile,
  answerConfirm,
  chooseMenuItem,
  confirmText,
  createBoard,
  documentZoomShown,
  errorToasts,
  kanbanCards,
  mindMapTiles,
  openNoteFromSidebar,
  pressShortcut,
  quickAddTask,
  rawConflictShown,
  rawViewShown,
  revealInSidebar,
  rightClick,
  setCardDueDate,
  splitActiveTabRight,
  startTaskTitleEdit,
  openTaskNotes,
  taskRows,
  toggleRawView,
  toggleSpellCheck,
  trashedPaths,
  typeInRawView,
  undo,
} from './harness/actions';
import { focusNoteText, openSearchPanel, pressEscape, searchPanelOpen, setWindowWidth, workspacePushedBy } from './harness/interfaceChrome';
import { selectTile, selectedTileTitles } from './harness/mindMapKeys';
import { cardByTitle, collapseKanbanColumn, focusKanbanBoard, selectedCardTitles } from './harness/listKeys';
import {
  cardDueChip,
  closePaneAt,
  ctrlClickSidebarRow,
  drawFrames,
  drawnFrameTitles,
  paneCount,
  pressZoomKey,
  rawViewField,
  readOnlyBanner,
  saveWaypointHere,
  setCardDueTime,
  sidebarSelectionCount,
  spellCheckedField,
  takeOwnershipQuestion,
  toggleFrameFold,
  waypointsPanelShown,
} from './harness/viewsAndPanels';

afterEach(async () => {
  await stopApp();
});

describe('the Mind Map', () => {
  it('folding a frame hides the frames inside it, and unfolding shows them again', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await drawFrames([
      { title: 'Act 1', x: 0, y: 0, width: 900, height: 700 },
      { title: 'Scene 1', x: 100, y: 120, width: 300, height: 200 },
      { title: 'Act 2', x: 1000, y: 0, width: 400, height: 300 },
    ]);
    expect(drawnFrameTitles(app).sort()).toEqual(['Act 1', 'Act 2', 'Scene 1']);

    await toggleFrameFold(app, 'Act 1');
    expect(drawnFrameTitles(app).sort()).toEqual(['Act 1', 'Act 2']);
    await toggleFrameFold(app, 'Act 1');
    expect(drawnFrameTitles(app).sort()).toEqual(['Act 1', 'Act 2', 'Scene 1']);
  });

  it('the Waypoints panel stays hidden until the board has a waypoint', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    expect(waypointsPanelShown(app)).toBe(false);
    await saveWaypointHere(app);
    await waitFor(() => waypointsPanelShown(app), 'the Waypoints panel');
  });

  it('Escape clears the selection, as on Kanban and the Task List, and Search stays for the next one', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Aria' });
    await openSearchPanel();
    await selectTile(mindMapTiles(app)[0]!.el);
    expect(selectedTileTitles(app)).toEqual(['Aria']);

    await pressEscape();
    expect(selectedTileTitles(app)).toEqual([]);
    expect(searchPanelOpen()).toBe(true);
    await pressEscape();
    expect(searchPanelOpen()).toBe(false);
  });
});

describe('a Document tab', () => {
  const NOTES = { 'Aria.md': '---\ntitle: Aria\n---\nAria Kasai rode north.\n' };

  it('zooms in with Ctrl and + on the number pad and Ctrl+Shift+=, and the zoom keys work in the Raw view', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Aria.md');
    await focusNoteText(app);
    const text = document.activeElement!;
    await pressZoomKey(text, '+', { code: 'NumpadAdd' });
    expect(documentZoomShown(app).label).toBe('110%');
    await pressZoomKey(text, '+', { code: 'Equal', shiftKey: true });
    expect(documentZoomShown(app).label).toBe('125%');

    await toggleRawView(app);
    const raw = rawViewField(app);
    await pressZoomKey(raw, '-', { code: 'Minus' });
    expect(documentZoomShown(app).label).toBe('110%');
    await pressZoomKey(raw, '0', { code: 'Digit0' });
    expect(documentZoomShown(app).label).toBe('100%');
    await pressZoomKey(raw, '=', { code: 'Equal' });
    expect(documentZoomShown(app).label).toBe('110%');
    expect(app.read('Aria.md')).toBe(NOTES['Aria.md']);
  });

  it('zoomed to 150% on a 1,366 px laptop, the docked sidebar moves the page aside instead of lying over its start', async () => {
    const app = await startApp(NOTES);
    await setWindowWidth(1366);
    try {
      await openNoteFromSidebar(app, 'Aria.md');
      expect(workspacePushedBy(app)).toBe('');
      await focusNoteText(app);
      for (let i = 0; i < 3; i++) await pressZoomKey(document.activeElement!, '=');
      expect(documentZoomShown(app).label).toBe('150%');
      await waitFor(() => workspacePushedBy(app) !== '', 'the workspace moved aside');
      expect(workspacePushedBy(app)).toBe('240px');
      await pressZoomKey(document.activeElement!, '0');
      await waitFor(() => workspacePushedBy(app) === '', 'the sidebar back over the workspace');
    } finally {
      await setWindowWidth(1920);
    }
  });

  it("a read-only note's banner names the list a save would split, and Take ownership lists it first", async () => {
    const REVIEW = [
      '---',
      'title: Review',
      '---',
      '',
      '# Review',
      '**Decisions:**',
      '- **Merged:** 1 and 2',
      '',
      '### 1. Kindled status',
      '- `From Keep`: hybrid status',
      '- **Proposal:** fold them in.',
      '- [ ] Merge  [ ] Keep separate',
      '',
    ].join('\n');
    const app = await startApp({ 'Review.md': REVIEW });
    await openNoteFromSidebar(app, 'Review.md');
    await waitFor(() => readOnlyBanner(app) !== null, 'the read-only banner');
    expect(readOnlyBanner(app)).toBe(
      "Filo can't save this file without changing formatting it doesn't support, so it's open read-only. "
      + 'Line 10: this list would be split into a list and a checklist.',
    );
    const question = await takeOwnershipQuestion(app);
    const listed = question.slice(question.indexOf('•'));
    expect(listed.startsWith('• Line 10: this list would be split into a list and a checklist')).toBe(true);
    expect(app.read('Review.md')).toBe(REVIEW);
  });
});

describe('Spelling off', () => {
  it("reaches a task's title box and notes box, and back on again", async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Draft chapter');
    const row = (): HTMLElement => taskRows(app)[0]!.el;

    await toggleSpellCheck(app);
    await startTaskTitleEdit(row());
    expect(spellCheckedField(row().querySelector('input.task-title-input')!)).toBe(false);
    await pressEscape(row().querySelector('input.task-title-input')!);
    await openTaskNotes(row());
    await waitFor(() => row().querySelector('textarea.task-notes-textarea') !== null, 'the notes box');
    expect(spellCheckedField(row().querySelector('textarea.task-notes-textarea')!)).toBe(false);

    await toggleSpellCheck(app);
    expect(spellCheckedField(row().querySelector('textarea.task-notes-textarea')!)).toBe(true);
  });
});

describe('closing a split pane over a Raw view', () => {
  const NOTE = '---\ntitle: Plan\n---\nOriginal\n';
  const MINE = '---\ntitle: Plan\n---\nTyped in the raw view\n';
  const THEIRS = '---\ntitle: Plan\n---\nTheirs\n';

  it("asks when its text can't be saved: Cancel keeps the pane, Close pane anyway keeps a copy", async () => {
    const app = await startApp({ 'Plan.md': NOTE, 'Other.md': '---\ntitle: Other\n---\nOther\n' });
    await openNoteFromSidebar(app, 'Other.md');
    await openNoteFromSidebar(app, 'Plan.md');
    await splitActiveTabRight(app);
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', THEIRS);
    await quiesce(2500);
    await waitFor(() => rawConflictShown(app), 'the raw conflict banner');

    await closePaneAt(app, 1);
    await waitFor(() => confirmText().includes('Close pane anyway'), 'the close question');
    await answerConfirm(app, { confirm: false });
    expect(paneCount(app)).toBe(2);
    expect(rawViewShown(app)).toBe(true);
    expect([...recoveryCopies(app).values()]).not.toContain(MINE);

    await closePaneAt(app, 1);
    await waitFor(() => confirmText().includes('Close pane anyway'), 'the close question again');
    await answerConfirm(app, { confirm: true });
    await waitFor(() => paneCount(app) === 1, 'one pane');
    await waitFor(() => [...recoveryCopies(app).values()].includes(MINE), 'a rescue copy of the raw text');
    expect(app.read('Plan.md')).toBe(THEIRS);
  });
});

describe('the sidebar', () => {
  it("Escape clears the sidebar's selection and leaves the Search panel open for the next one", async () => {
    const app = await startApp({ 'Aria.md': 'Aria\n', 'Vel.md': 'Vel\n' });
    await openSearchPanel();
    await ctrlClickSidebarRow(await revealInSidebar(app, 'Aria.md'));
    await ctrlClickSidebarRow(await revealInSidebar(app, 'Vel.md'));
    expect(sidebarSelectionCount(app)).toBe(2);

    await pressEscape();
    expect(sidebarSelectionCount(app)).toBe(0);
    expect(searchPanelOpen()).toBe(true);
    await pressEscape();
    expect(searchPanelOpen()).toBe(false);
  });
});

describe('a Kanban card', () => {
  it('Ctrl+A selects the cards on screen, a collapsed column\'s none', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    await addKanbanCard(app, 0, { title: 'Alpha' });
    await addKanbanCard(app, 0, { title: 'Bravo' });
    await addKanbanCard(app, 1, { title: 'Hidden' });
    await collapseKanbanColumn(app, 1);
    await focusKanbanBoard(app);
    pressShortcut('a', { ctrlKey: true });
    await quiesce(200);
    expect(selectedCardTitles(app).sort()).toEqual(['Alpha', 'Bravo']);
  });

  it('its menu puts Move to column before Remove from board, then Delete from vault…, which takes the note to the trash; undo brings both back', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    const rel = await addKanbanCard(app, 0, { title: 'Siege' });
    const labels = await rightClick(cardByTitle(app, 'Siege'));
    expect(labels!.slice(labels!.indexOf('Style…'))).toEqual(['Style…', 'New Column', 'Remove from board', 'Delete from vault…']);

    await chooseMenuItem(app, 'Delete from vault…');
    await waitFor(() => confirmText().includes('Delete card and file'), 'the delete question');
    await answerConfirm(app, { confirm: true });
    await waitFor(() => kanbanCards(app).length === 0, 'the card gone');
    await waitFor(() => !app.exists(rel), 'the note gone');
    expect(trashedPaths(app)).toContain(rel);

    await undo(app);
    await waitFor(() => app.exists(rel), 'the note back');
    await waitFor(() => kanbanCards(app).map((c) => c.title).includes('Siege'), 'the card back');
    expect(errorToasts()).toEqual([]);
  });

  it('its date picker has a time box, as a task\'s does, and the chip shows the time', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const rel = await addKanbanCard(app, 0, { title: 'Launch' });
    await setCardDueDate(cardByTitle(app, 'Launch'), '2026-11-02');
    await setCardDueTime(cardByTitle(app, 'Launch'), '17:30');
    await waitFor(() => /^dueTime: ["']?17:30["']?$/m.test(app.read(rel)), 'the time in the note');
    expect(cardDueChip(cardByTitle(app, 'Launch'))).toMatch(/5:30pm$/);
  });
});
