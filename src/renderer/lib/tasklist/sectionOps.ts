/**
 * Section CRUD slice for TaskListBoard.
 *
 * Owns:
 *   - `persistSections` (single write path that routes through
 *     `boardCache.persistTaskListStructure` and bumps the host tick)
 *   - `ensureDefaultSectionMaterialized` (turns the virtual `__default__`
 *     placeholder into a real persisted section)
 *   - `addSection`, `renameSection`, `toggleSectionCollapsed`,
 *     `deleteSection` (`keep-tasks` / `delete-tasks` modes), `moveSection`
 *
 * Each undoable mutation dispatches an `historyStore.execute(...)` of the
 * appropriate structural Command. Collapse toggling is intentionally
 * non-undoable (transient UI preference) and goes straight to
 * `persistSections`.
 *
 * Why a factory:
 *   These operations need live reads of `board` / `sections` / `placements`.
 *   Threading those through a deps object mirrors `taskCreation` /
 *   `taskDeletion` / `fileDropHandler`. No `$state` lives in this slice.
 */

import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
} from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { historyStore } from '../../stores/history.svelte';
import { createId } from '../utils/ids';
import { defaultTaskSectionFontSizes } from '../styles/defaultFontSizes';
import {
  AddSectionCommand,
  DeleteSectionCommand,
  RenameSectionCommand,
  ReorderSectionCommand,
} from '../../commands/index';

/**
 * A new section, with the Settings default for its header size baked in as
 * its own style (as a new task gets its font sizes): changing the default
 * later never rewrites existing sections.
 */
function newSection(id: string, title: string, position: number): TaskListSection {
  const { fontSizeTitle } = defaultTaskSectionFontSizes();
  return {
    id, title, position, collapsed: false,
    ...(fontSizeTitle !== undefined && { style: { fontSizeTitle } }),
  } as TaskListSection;
}

export interface SectionOpsDeps {
  getBoard: () => TaskListBoardType | null;
  getSections: () => TaskListSection[];
  getPlacements: () => TaskPlacement[];
  tickAndPersist: () => void;
  /** Snapshot helper (used by undoable ops). Host-owned so other call sites share it. */
  snapshotSections: () => { sections: TaskListSection[]; tasks: TaskPlacement[] };
  /** Sentinel id of the virtual default section (`__default__`). */
  defaultSectionId: string;
}

export interface SectionOps {
  persistSections(next: TaskListSection[], nextTasks?: TaskPlacement[]): void;
  ensureDefaultSectionMaterialized(initialTitle?: string): string | null;
  addSection(title?: string): void;
  renameSection(id: string, title: string): void;
  toggleSectionCollapsed(id: string): void;
  deleteSection(id: string, mode: 'keep-tasks' | 'delete-tasks'): void;
  moveSection(id: string, direction: -1 | 1): void;
}

export function makeSectionOps(deps: SectionOpsDeps): SectionOps {
  // ── persistSections ──
  //
  // Single write path. Section `position` values are absolute indices into
  // `tasks`, so an inconsistent update can split a board's task list from
  // its section markers — funnelling every section mutation through one
  // method keeps the two arrays consistent.
  function persistSections(
    next: TaskListSection[],
    nextTasks?: TaskPlacement[],
  ): void {
    const board = deps.getBoard();
    if (!board) return;
    boardCacheStore.persistTaskListStructure(board.id, next, nextTasks);
    deps.tickAndPersist();
  }

  // Materialise the virtual default section into the persisted sections array.
  // Returns the real section id (replacing `__default__`) so callers can
  // continue an operation against it (rename, collapse, …) in the same tick.
  // No-op when at least one real section already exists.
  function ensureDefaultSectionMaterialized(initialTitle = 'Task List'): string | null {
    const board = deps.getBoard();
    if (!board) return null;
    if (deps.getSections().length > 0) return null;
    const id = `sec_${createId()}`;
    // Materialisation is a UX side-effect of the user's main action (rename,
    // collapse, addSection). Bundling it into the same history entry would
    // make Ctrl+Z replay an unexpected default-section creation, so we
    // persist it directly without pushing a Command — the parent op's own
    // Command captures the materialised state in its before-snapshot.
    persistSections([newSection(id, initialTitle, 0)]);
    return id;
  }

  function addSection(title = 'New Section'): void {
    const board = deps.getBoard();
    if (!board) return;
    // Snapshot the TRUE pre-add shape (possibly the section-less `[]`
    // state) BEFORE materialising the default. When the board has only the
    // virtual default, the new section needs the existing unsectioned tasks to
    // keep a home, so we also materialise a real default — but we fold that into
    // the command (via `autoDefault`) instead of a separate command-less
    // pre-persist, so the command's undo can strip BOTH and restore `[]`
    // (otherwise add-then-undo would leave a materialised default on disk).
    const before = deps.snapshotSections();
    const wasEmpty = before.sections.length === 0;
    const autoDefault: TaskListSection | null = wasEmpty
      ? newSection(`sec_${createId()}`, 'Task List', 0)
      : null;
    const id = `sec_${createId()}`;
    const placements = deps.getPlacements();
    const baseSections = autoDefault ? [autoDefault] : before.sections;
    const after = {
      sections: [...baseSections, newSection(id, title, placements.length)],
      tasks: before.tasks,
    };
    historyStore.execute(new AddSectionCommand(board.id, before, after, title, autoDefault));
    deps.tickAndPersist();
  }

  function renameSection(id: string, title: string): void {
    const board = deps.getBoard();
    if (!board) return;
    // Renaming the virtual default materialises with the new title in one step.
    if (id === deps.defaultSectionId) {
      ensureDefaultSectionMaterialized(title);
      return;
    }
    const sections = deps.getSections();
    const target = sections.find((s) => s.id === id);
    if (!target || target.title === title) return;
    historyStore.execute(
      new RenameSectionCommand(board.id, id, target.title, title, sections),
    );
    deps.tickAndPersist();
  }

  function toggleSectionCollapsed(id: string): void {
    if (id === deps.defaultSectionId) {
      const real = ensureDefaultSectionMaterialized();
      if (!real) return;
      const next = deps
        .getSections()
        .map((s) => (s.id === real ? { ...s, collapsed: !s.collapsed } : s));
      // Toggling collapse is a transient UI preference; we persist it but
      // don't pollute history with it (no Command).
      persistSections(next);
      return;
    }
    const next = deps
      .getSections()
      .map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s));
    persistSections(next);
  }

  function deleteSection(id: string, mode: 'keep-tasks' | 'delete-tasks'): void {
    const board = deps.getBoard();
    if (!board) return;
    // The virtual default isn't persisted, so there's nothing to delete.
    if (id === deps.defaultSectionId) return;
    const sections = deps.getSections();
    const placements = deps.getPlacements();
    const sorted = [...sections].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const target = sorted[idx];
    if (!target) return; // idx >= 0 from findIndex; narrow for the type-checker
    const end = sorted[idx + 1]?.position ?? placements.length;
    const beforeSnap = {
      sections: sections.map((s) => ({ ...s })),
      tasks: placements.map((p) => ({ ...p })),
      defs: { ...boardCacheStore.cache[board.id]?.tileDefs },
    };

    if (mode === 'keep-tasks') {
      const afterSnap = {
        sections: sorted.filter((s) => s.id !== id).map((s) => ({ ...s })),
        tasks: placements.map((p) => ({ ...p })),
        defs: { ...beforeSnap.defs },
      };
      historyStore.execute(
        new DeleteSectionCommand(board.id, beforeSnap, afterSnap, target.title),
      );
      deps.tickAndPersist();
      return;
    }

    const tilesToRemove = placements.slice(target.position, end).map((p) => p.tileId);
    const removeSet = new Set(tilesToRemove);
    const nextTasks = placements.filter((p) => !removeSet.has(p.tileId));
    const nextSections = sorted
      .filter((s) => s.id !== id)
      .map((s) =>
        s.position >= end ? { ...s, position: s.position - tilesToRemove.length } : s,
      );
    const nextDefs = { ...beforeSnap.defs };
    for (const tileId of tilesToRemove) delete nextDefs[tileId];
    const afterSnap = { sections: nextSections, tasks: nextTasks, defs: nextDefs };
    historyStore.execute(
      new DeleteSectionCommand(board.id, beforeSnap, afterSnap, target.title),
    );
    deps.tickAndPersist();
  }

  function moveSection(id: string, direction: -1 | 1): void {
    const board = deps.getBoard();
    if (!board) return;
    if (id === deps.defaultSectionId) return;
    const sections = deps.getSections();
    const placements = deps.getPlacements();
    const sorted = [...sections].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;

    const a = sorted[idx];
    const b = sorted[swapIdx];
    if (!a || !b) return; // idx/swapIdx bounds-checked above; narrow for the type-checker
    const aStart = a.position;
    const aEnd = sorted[idx + 1]?.position ?? placements.length;
    const bStart = b.position;
    const bEnd = sorted[swapIdx + 1]?.position ?? placements.length;

    const aSlice = placements.slice(aStart, aEnd);
    const bSlice = placements.slice(bStart, bEnd);
    let nextTasks: TaskPlacement[];
    let nextSorted: TaskListSection[];
    if (direction === 1) {
      const before = placements.slice(0, aStart);
      const after = placements.slice(bEnd);
      nextTasks = [...before, ...bSlice, ...aSlice, ...after];
      nextSorted = sorted.map((s) => {
        if (s.id === a.id) return { ...s, position: aStart + bSlice.length };
        if (s.id === b.id) return { ...s, position: aStart };
        return s;
      });
    } else {
      const before = placements.slice(0, bStart);
      const after = placements.slice(aEnd);
      nextTasks = [...before, ...aSlice, ...bSlice, ...after];
      nextSorted = sorted.map((s) => {
        if (s.id === b.id) return { ...s, position: bStart + aSlice.length };
        if (s.id === a.id) return { ...s, position: bStart };
        return s;
      });
    }
    const before = deps.snapshotSections();
    historyStore.execute(
      new ReorderSectionCommand(board.id, before, { sections: nextSorted, tasks: nextTasks }),
    );
    deps.tickAndPersist();
  }

  return {
    persistSections,
    ensureDefaultSectionMaterialized,
    addSection,
    renameSection,
    toggleSectionCollapsed,
    deleteSection,
    moveSection,
  };
}
