/**
 * A board made from a Markdown template with a ```filo-board``` block: a new
 * board of the block's type, with its settings, and the columns and cards,
 * sections and tasks, or tiles its skeleton lists (`schema/boardTemplate.ts`).
 * Each card, task and tile gets a note of its own in the board's folder,
 * named after its title like any new one.
 *
 * The template's own text (outside the block), with its frontmatter, goes
 * into the first of them that has no text yet, or into a note of its own,
 * titled after the template, first on the board.
 */
import type { Board, Tile, TileDefinition } from '../../schema/index';
import type { BoardType } from '../../../shared/types';
import { BoardTemplateSkeletonSchema, MAX_TEMPLATE_ITEMS, type BoardTemplateItem, type BoardTemplateSkeleton } from '../../schema/boardTemplate';
import { boardDefaults } from '../../core/boardDefaults';
import { boardStore } from '../../stores/board.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { createTile } from '../../stores/tiles.svelte';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { createNoteFile } from '../notes/createNote';
import { fileNameSafe, getActiveContentFolder } from '../vault/conventionPaths';
import { withTemplateSettings } from './templateBoardSettings';
import { freeNewBoardName } from '../boards/newBoardPlace';
import { placeClear, type PlacedRect } from '../canvas/newTilePlacement';
import { createId } from '../utils/ids';
import { localIsoDate } from '../utils/dateFormat';
import { reportError } from '../utils/errorBus';
import { interpolate, type TemplateContent, type TemplateRef } from './templateService';
import { noteFromTemplate, type NoteFromTemplate } from './templateNote';

/** The board types a template can make. */
const TEMPLATE_BOARD_TYPES: ReadonlySet<string> = new Set(['mindmap', 'kanban', 'tasklist']);

/** A note the skeleton asks for, before it exists. */
interface PlannedNote {
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

function planned(item: BoardTemplateItem, now: Date): PlannedNote {
  const title = interpolate(typeof item === 'string' ? item : item.title, { now }).trim() || 'Untitled';
  const body = typeof item === 'string' ? '' : interpolate(item.body ?? '', { title, now });
  return { title, body, frontmatter: {} };
}

/**
 * Puts the template's own text in the first planned note without text, or in
 * a note of its own at the front. `notes` lists the board's notes in order.
 */
function placeProse(notes: PlannedNote[], prose: NoteFromTemplate): PlannedNote | null {
  if (!prose.body.trim()) return null;
  const empty = notes.find((n) => !n.body.trim());
  if (empty) {
    empty.body = prose.body;
    empty.frontmatter = prose.frontmatter;
    return null;
  }
  return { title: prose.title, body: prose.body, frontmatter: prose.frontmatter };
}

/** Makes the note; its path, or null when it couldn't be made (said so). */
async function makeNote(note: PlannedNote, folder: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return null;
  try {
    const { relPath } = await createNoteFile({ vaultRoot, folder, title: note.title, frontmatter: { ...note.frontmatter, ...extra }, body: note.body });
    return relPath;
  } catch (err) {
    reportError('boardFromTemplate.note', err, `Couldn't make the note "${note.title}" for the new board`);
    return null;
  }
}

function textDef(relPath: string): TileDefinition {
  const now = Date.now();
  return { id: createId(), type: 'text', style: defaultTileStyleSnapshot(), createdAt: now, updatedAt: now, filePath: relPath };
}

async function fillKanban(board: Board, skeleton: BoardTemplateSkeleton, prose: NoteFromTemplate, folder: string, now: Date): Promise<void> {
  const columns = (skeleton.columns ?? []).map((c) => ({ title: interpolate(c.title, { now }), cards: c.cards.map((i) => planned(i, now)) }));
  const extra = placeProse(columns.flatMap((c) => c.cards), prose);
  if (extra) {
    if (columns.length === 0) columns.push({ title: extra.title, cards: [] });
    columns[0]!.cards.unshift(extra);
  }
  let made = 0;
  for (const column of columns) {
    const columnId = createId();
    boardCacheStore.addKanbanColumn(board.id, { id: columnId, title: column.title });
    let at = 0;
    for (const card of column.cards) {
      if (made++ >= MAX_TEMPLATE_ITEMS) return;
      const relPath = await makeNote(card, folder);
      if (relPath) boardCacheStore.persistAddKanbanPlacement(board.id, columnId, textDef(relPath), at++);
    }
  }
}

async function fillTaskList(board: Board, skeleton: BoardTemplateSkeleton, prose: NoteFromTemplate, folder: string, now: Date): Promise<void> {
  const sections = (skeleton.sections ?? []).map((s) => ({ title: interpolate(s.title, { now }), tasks: s.tasks.map((i) => planned(i, now)) }));
  const extra = placeProse(sections.flatMap((s) => s.tasks), prose);
  if (sections.length === 0 && !extra) return;
  if (extra) {
    if (sections.length === 0) sections.push({ title: 'Task List', tasks: [] });
    sections[0]!.tasks.unshift(extra);
  }
  const structure: { id: string; title: string; position: number; collapsed: boolean }[] = [];
  let position = 0;
  for (const section of sections) {
    structure.push({ id: `sec_${createId()}`, title: section.title, position, collapsed: false });
    for (const task of section.tasks) {
      if (position >= MAX_TEMPLATE_ITEMS) break;
      const relPath = await makeNote(task, folder, { completed: false });
      if (!relPath) continue;
      boardCacheStore.persistAddTaskPlacement(board.id, textDef(relPath), position);
      position++;
    }
  }
  boardCacheStore.persistTaskListStructure(board.id, structure);
}

async function fillMindMap(board: Board, skeleton: BoardTemplateSkeleton, prose: NoteFromTemplate, folder: string, now: Date): Promise<void> {
  const tiles: Array<{ note: PlannedNote; x?: number; y?: number; width?: number; height?: number }> = (skeleton.tiles ?? [])
    .slice(0, MAX_TEMPLATE_ITEMS)
    .map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height, note: planned({ title: t.title, body: t.body }, now) }));
  const extra = placeProse(tiles.map((t) => t.note), prose);
  if (extra) tiles.unshift({ note: extra });
  const placed: PlacedRect[] = [];
  for (const spec of tiles) {
    const relPath = await makeNote(spec.note, folder);
    if (!relPath) continue;
    const tile = createTile('text', { x: 0, y: 0 }, board.id, { title: spec.note.title }) as Tile & { filePath?: string };
    tile.filePath = relPath;
    tile.size = { ...tile.size, ...(spec.width && { width: spec.width }), ...(spec.height && { height: spec.height }) };
    // Where the skeleton says, else dealt clear of the tiles before it.
    tile.position = spec.x !== undefined && spec.y !== undefined
      ? { ...tile.position, x: spec.x, y: spec.y }
      : { ...tile.position, ...placeClear({ x: 0, y: 0 }, tile.size, placed) };
    placed.push({ ...tile.position, ...tile.size });
    await boardCacheStore.persistAddTile(tile, undefined, board.id);
  }
}

/**
 * Makes the board a board template describes, filled in from its skeleton.
 * The board is named after the template and the day; a skeleton that can't
 * be read is refused with a message, and no board is made.
 */
export async function createBoardFromTemplate(ref: TemplateRef, content: TemplateContent, now: Date = new Date()): Promise<Board | null> {
  const parsed = BoardTemplateSkeletonSchema.safeParse(content.boardJson);
  if (!parsed.success || !TEMPLATE_BOARD_TYPES.has(parsed.data.type)) {
    uiStore.toast(
      content.boardJson === null
        ? `The filo-board block in template "${ref.name}" isn't valid JSON, so no board was made.`
        : `The board in template "${ref.name}" can't be read, so no board was made.`,
      'error',
      6000,
    );
    return null;
  }
  const skeleton = parsed.data;
  const type = skeleton.type as BoardType;
  // The name is the board's file name: one a file can have (a template's
  // title may hold `:` or `?`), free where the board goes.
  const name = freeNewBoardName(`${fileNameSafe(ref.name)} ${localIsoDate(now)}`);
  const board = boardDefaults[type](`${type}_${createId()}`, name, vaultStore.project?.settings);
  const { settings, refused } = withTemplateSettings(type, board.settings as Record<string, unknown>, skeleton.settings);
  board.settings = settings as typeof board.settings;
  // A failure has already said why.
  if (!(await boardStore.persistNewBoard(board))) return null;
  if (refused.length > 0) {
    const one = refused.length === 1;
    uiStore.toast(
      `"${board.name}" was made without the template's ${one ? 'setting' : 'settings'} ${refused.map((k) => `"${k}"`).join(', ')}: ${one ? "it isn't one" : "they aren't ones"} this kind of board can take.`,
      'warning',
      8000,
    );
  }
  const folder = getActiveContentFolder(boardCacheStore.cache[board.id]?.board ?? board);
  const prose = noteFromTemplate(content, ref.name, now);
  if (board.type === 'kanban') await fillKanban(board, skeleton, prose, folder, now);
  else if (board.type === 'tasklist') await fillTaskList(board, skeleton, prose, folder, now);
  else if (board.type === 'mindmap') await fillMindMap(board, skeleton, prose, folder, now);
  return board;
}
