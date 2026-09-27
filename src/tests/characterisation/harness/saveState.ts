/**
 * Save-state drivers for the characterisation suite: the floating Kanban
 * toolbar, the save indicator and failures the user is told about.
 */
import type { CharApp } from './app';
import { settle, waitFor } from './app';
import { BOARD_ROOT } from './actions';

function kanbanToolbar(app: CharApp): HTMLElement {
  const board = app.el.querySelector(BOARD_ROOT.kanban);
  const bar = (board?.querySelector('.side-toolbar') ?? app.el.querySelector('.side-toolbar')) as HTMLElement | null;
  if (!bar) throw new Error('no Kanban side toolbar');
  return bar;
}

function pointer(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
}

/** Drag the Kanban side toolbar by its background so its top-left lands at (x, y). */
export async function dragKanbanToolbar(app: CharApp, x: number, y: number): Promise<void> {
  const bar = kanbanToolbar(app);
  pointer(bar, 'pointerdown', 0, 0);
  pointer(bar, 'pointermove', x, y);
  pointer(bar, 'pointerup', x, y);
  await settle(100);
}

/** Click the Kanban side toolbar's pin button. */
export async function toggleKanbanToolbarPin(app: CharApp): Promise<void> {
  const pin = kanbanToolbar(app).querySelector<HTMLButtonElement>('button[aria-label="Pin toolbar"]');
  if (!pin) throw new Error('no pin button on the Kanban toolbar');
  pin.click();
  await settle(100);
}

/** Whether the Kanban side toolbar shows as pinned. */
export function kanbanToolbarPinned(app: CharApp): boolean {
  const pin = kanbanToolbar(app).querySelector('button[aria-label="Pin toolbar"]');
  return pin?.getAttribute('aria-pressed') === 'true';
}

/** The board toolbars `.filo/workspace.json` holds on disk (position and pin per board). */
export function savedBoardToolbars(app: CharApp): Array<{ position: { x: number; y: number } | null; pinned: boolean }> {
  const workspace = JSON.parse(app.read('.filo/workspace.json')) as {
    boardToolbars?: Record<string, { position: { x: number; y: number } | null; pinned: boolean }>;
  };
  return Object.values(workspace.boardToolbars ?? {});
}

/** Where the Kanban toolbar sits, or null while it is docked. */
export function kanbanToolbarPosition(app: CharApp): { x: number; y: number } | null {
  const bar = kanbanToolbar(app);
  const left = bar.style.left;
  const top = bar.style.top;
  if (!left || !top) return null;
  return { x: Number.parseFloat(left), y: Number.parseFloat(top) };
}

/** The one `.board.json` in the vault. */
export function onlyBoardFile(app: CharApp): string {
  const boards = app.userFiles().filter((rel) => rel.endsWith('.board.json'));
  if (boards.length !== 1) throw new Error(`expected one board file, have ${boards.length}`);
  return boards[0];
}

/** Kanban "Add Column", without waiting for the save. */
export async function clickAddKanbanColumn(app: CharApp): Promise<void> {
  const button = app.el.querySelector('button.add-column-btn') as HTMLElement | null;
  if (!button) throw new Error('no Add Column button');
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(20);
}

/** Kanban column titles, left to right. */
export function kanbanColumnTitles(app: CharApp): string[] {
  return Array.from(app.el.querySelectorAll('.kanban-column .column-title')).map((el) => (el.textContent ?? '').trim());
}

/**
 * Runs `during` while Filo's next read of `rel` is held: the read a note's
 * save makes just before it writes, so `during` happens with the save out.
 */
export async function whileSaveReads(app: CharApp, rel: string, during: () => Promise<void>): Promise<void> {
  const hold = app.bridge.holdReads(rel);
  try {
    await waitFor(() => hold.count() >= 1, `the save's read of ${rel}`);
    await during();
  } finally {
    hold.release();
  }
  await settle();
}

/** What the toolbar's save indicator shows: 'saved', 'saving', 'error' or 'attention'. */
export function saveIndicator(app: CharApp): string {
  const el = app.el.querySelector('.save-indicator');
  const state = Array.from(el?.classList ?? []).find((c) => c.startsWith('save-') && c !== 'save-indicator');
  return state ? state.slice('save-'.length) : 'none';
}

/** Dismiss every toast on screen with its close button. */
export async function dismissAllToasts(): Promise<void> {
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.toast .toast-close'))) {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await settle(50);
}

/** Click the save indicator; returns the popover's rows (file and line), or [] when none opens. */
export async function openSavePopover(app: CharApp): Promise<string[]> {
  const el = app.el.querySelector('.save-indicator') as HTMLElement | null;
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(50);
  return Array.from(document.querySelectorAll('.save-error-popover li')).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
}

/** The popover's "Show" button for the held decision about `relPath`. */
export async function showHeldDecision(relPath: string): Promise<void> {
  const row = Array.from(document.querySelectorAll('.save-error-popover li')).find((li) => li.getAttribute('title') === relPath);
  const btn = row?.querySelector('button') as HTMLElement | null | undefined;
  if (!btn) throw new Error(`no held decision for ${relPath} in the save popover`);
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(50);
}

/** The recovery modal's text, its rows and its buttons (empty when it isn't open). */
export function recoveryModal(): { text: string; rows: string[]; buttons: string[] } {
  const body = document.querySelector('.recovery-body');
  if (!body) return { text: '', rows: [], buttons: [] };
  return {
    text: (body.textContent ?? '').replace(/\s+/g, ' ').trim(),
    rows: Array.from(body.querySelectorAll('.recovery-item')).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim()),
    buttons: Array.from(body.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim()),
  };
}
