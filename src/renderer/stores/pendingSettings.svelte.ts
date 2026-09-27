import type { ProjectSettings } from '../schema/index';
import {
  MindMapDefaultsSchema,
  KanbanDefaultsSchema,
  TaskListDefaultsSchema,
  DocumentDefaultsSchema,
  boardSettingsSchemaFor,
} from '../schema/index';
import type { BoardType } from '../../shared/types';
import type { Board } from '../schema/index';
import type { z } from 'zod';
import { vaultStore } from './vault.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { tabStore } from './tabs.svelte';
import { workspaceStore } from './workspace.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * The part of `project.settings` the Global Defaults tab edits: the
 * per-board-type style defaults (`defaults.json`). Everything else in
 * `project.settings` (the General tab, recent colours, a theme's reset of
 * the default colours) is written live by other parts of the dialog, so the
 * pending copy must never hold it: an Apply would put back whatever it
 * held when the dialog opened.
 */
export const GLOBAL_DEFAULTS_KEYS = ['mindmap', 'kanban', 'tasklist', 'document'] as const;
type GlobalDefaultsKey = (typeof GLOBAL_DEFAULTS_KEYS)[number];
export type GlobalDefaults = Pick<ProjectSettings, GlobalDefaultsKey>;

const GLOBAL_DEFAULTS_SCHEMAS: Record<GlobalDefaultsKey, z.ZodType> = {
  mindmap: MindMapDefaultsSchema,
  kanban: KanbanDefaultsSchema,
  tasklist: TaskListDefaultsSchema,
  document: DocumentDefaultsSchema,
};

/** What an Apply did: wrote something, found nothing to write, or refused. */
export type ApplyResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Drops `undefined` values and objects left empty, so an override set and
 * then cleared back to Inherit (which leaves `defaults: { tile: {} }`)
 * compares equal to never having been set.
 */
function prune(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) {
    const v = prune(value[k]);
    if (v === undefined) continue;
    if (isPlainObject(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Key-order-independent comparison form of a settings tree. */
function comparable(value: unknown): string {
  return JSON.stringify(prune(value));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `live` with the edits that turned `base` into `edited` applied to it. A
 * field the user didn't touch keeps its live value, so something else that
 * changed the settings while the dialog was open (a theme's colour reset, a
 * Mind Map toggle) isn't written back to the value it had at the start.
 */
function applyEdits(base: unknown, edited: unknown, live: unknown): unknown {
  if (comparable(base) === comparable(edited)) return live;
  if (!isPlainObject(edited)) return edited === undefined ? undefined : deepClone(edited);
  const from = isPlainObject(base) ? base : {};
  const out: Record<string, unknown> = isPlainObject(live) ? { ...live } : {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(edited)])) {
    const next = applyEdits(from[key], edited[key], out[key]);
    if (next === undefined) delete out[key];
    else out[key] = next;
  }
  return out;
}

/**
 * The board the Current Board tab edits: the active pane's board, or none
 * when that pane shows a note (a Document tab), whose pane still holds the
 * board it showed before.
 */
export function settingsBoard(): Board | null {
  const leaf = workspaceStore.activeLeaf;
  const tab = leaf ? tabStore.tabs.find((t) => t.id === leaf.tabId) : tabStore.activeTab;
  if (tab && (tab.notePath !== undefined || tab.boardType === 'document')) return null;
  return boardStore.current;
}

function sliceOf(settings: ProjectSettings): GlobalDefaults {
  return {
    mindmap: settings.mindmap,
    kanban: settings.kanban,
    tasklist: settings.tasklist,
    document: settings.document,
  };
}

function firstIssue(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) return 'the values are not valid';
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Sets the field at a dotted path, creating intermediate objects. Setting
 * `undefined` deletes the key and any parent it leaves empty, so clearing an
 * override removes it rather than leaving `{}` behind.
 */
function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const chain: Array<[Record<string, unknown>, string]> = [];
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue; // i < parts.length - 1; narrow for the type-checker
    if (!isPlainObject(cursor[key])) {
      if (value === undefined) return; // nothing there to clear
      cursor[key] = {};
    }
    chain.push([cursor, key]);
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey === undefined) return; // split() always yields >= 1 part
  if (value !== undefined) {
    cursor[lastKey] = value;
    return;
  }
  delete cursor[lastKey];
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i];
    if (!link) break;
    const [parent, key] = link;
    const child = parent[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
}

/**
 * Pending-settings store: backs the Settings dialog's Apply / Revert.
 *
 * Two scopes are tracked in parallel:
 *
 *   - Global Defaults (`pending`): a copy of the per-board-type style
 *     defaults only (see `GLOBAL_DEFAULTS_KEYS`).
 *   - Current Board (`pendingBoardSettings`): a copy of one board's
 *     `settings` block, pinned to `pendingBoardId`.
 *
 * `effective` / `effectiveBoardSettings` return the editable copy during a
 * session and the live values otherwise, so the same controls work inside
 * and outside the dialog.
 */

let pending = $state<GlobalDefaults | null>(null);
/** The Global Defaults as they were when `pending` was copied. */
let pendingBase = $state.raw<GlobalDefaults | null>(null);
let pendingBoardSettings = $state<Record<string, unknown> | null>(null);
/** The board's settings as they were when `pendingBoardSettings` was copied. */
let pendingBoardBase = $state.raw<Record<string, unknown> | null>(null);
let pendingBoardId = $state<string | null>(null);
let pendingBoardType = $state<BoardType | null>(null);

function liveBoardSettings(boardId: string): Record<string, unknown> | undefined {
  // Prefer the cache (authoritative, and it survives a tab switch); fall
  // back to the active board if the cache has no entry.
  const cached = boardCacheStore.cache[boardId];
  if (cached) return cached.board.settings as Record<string, unknown>;
  const active = boardStore.current;
  return active?.id === boardId ? (active.settings as Record<string, unknown>) : undefined;
}

export const pendingSettingsStore = {
  /** Whether an Apply / Revert session is in progress. */
  get active(): boolean {
    return pending !== null || pendingBoardSettings !== null;
  },

  /**
   * The user edited the Global Defaults copy. Compared with the copy's
   * starting point, not the live settings: a live change made while the
   * dialog is open is not an edit and must not ask "Discard changes?".
   */
  hasGlobalChanges(): boolean {
    if (pending === null || pendingBase === null) return false;
    return comparable(pending) !== comparable(pendingBase);
  },

  /** The user edited the Current Board copy (see `hasGlobalChanges`). */
  hasBoardChanges(): boolean {
    if (pendingBoardSettings === null || pendingBoardId === null || pendingBoardBase === null) return false;
    return comparable(pendingBoardSettings) !== comparable(pendingBoardBase);
  },

  /**
   * True when either tab has edits that differ from the live values. Drives
   * the dialog's discard-changes confirmation, so a session with nothing to
   * lose closes without asking.
   */
  hasUnsavedChanges(): boolean {
    return this.hasGlobalChanges() || this.hasBoardChanges();
  },

  // ── Global Defaults ────────────────────────────────────────────────

  get pending(): GlobalDefaults | null {
    return pending;
  },

  /**
   * The project settings the UI should render against: the live settings,
   * with the pending style defaults laid over them during a session.
   */
  get effective(): ProjectSettings | null {
    const live = vaultStore.project?.settings ?? null;
    if (!live || !pending) return live;
    return { ...live, ...pending };
  },

  // ── Current Board ──────────────────────────────────────────────────

  get pendingBoardSettings(): Record<string, unknown> | null {
    return pendingBoardSettings;
  },

  get pendingBoardId(): string | null {
    return pendingBoardId;
  },

  get pendingBoardType(): BoardType | null {
    return pendingBoardType;
  },

  /**
   * The current board's settings (including the `defaults` override block).
   * Inside a session this is the editable copy; otherwise the active board's.
   */
  get effectiveBoardSettings(): Record<string, unknown> | null {
    if (pendingBoardSettings) return pendingBoardSettings;
    const board = settingsBoard();
    return (board?.settings as Record<string, unknown>) ?? null;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Copies the live style defaults into `pending`. Re-arms the Global
   * Defaults tab without touching the Current Board copy.
   */
  startGlobal(): void {
    const live = vaultStore.project?.settings;
    if (!live) return;
    pendingBase = deepClone(sliceOf(live));
    pending = deepClone(pendingBase);
  },

  /**
   * Copies the settings of the board the Current Board tab edits
   * (`settingsBoard`) into `pendingBoardSettings`, from the board cache (the
   * copy that is saved). Re-arms the Current Board tab without touching the
   * Global Defaults copy.
   */
  startBoard(): void {
    const board = settingsBoard();
    const live = board ? liveBoardSettings(board.id) : undefined;
    if (board && live) {
      pendingBoardId = board.id;
      pendingBoardType = board.type;
      pendingBoardBase = deepClone(live);
      pendingBoardSettings = deepClone(live);
    } else {
      pendingBoardId = null;
      pendingBoardType = null;
      pendingBoardSettings = null;
      pendingBoardBase = null;
    }
  },

  /**
   * Begins a session by copying both scopes (the dialog's mount). Per-tab
   * Apply / Revert re-arm only their own scope (`startGlobal` /
   * `startBoard`): this would wipe the other tab's unapplied edits.
   */
  start(): void {
    this.startGlobal();
    this.startBoard();
  },

  /**
   * Sets a field at a dotted path in the Global Defaults copy. Paths start
   * with a board type (`mindmap.tile.borderWidth`).
   *
   * Every write deep-clones, so the top-level reference and every object on
   * the path are new: `$derived` readers of deep paths (LivePreview, a
   * ColorPicker's `value`) would otherwise miss the change.
   */
  update(path: string, value: unknown): void {
    if (!pending) return;
    const top = path.split('.')[0] as GlobalDefaultsKey;
    if (!GLOBAL_DEFAULTS_KEYS.includes(top)) {
      console.warn(`[pendingSettings] "${path}" is not a Global Defaults field`);
      return;
    }
    const next: Record<string, unknown> = deepClone(pending);
    setNestedField(next, path, value);
    pending = next as GlobalDefaults;
  },

  /** Sets a field at a dotted path in the Current Board copy. */
  updateBoard(path: string, value: unknown): void {
    if (!pendingBoardSettings) return;
    const next = deepClone(pendingBoardSettings);
    setNestedField(next, path, value);
    pendingBoardSettings = next;
  },

  /**
   * Writes the Global Defaults copy back into `project.settings`, touching
   * only the style-defaults keys. Refuses (keeping the copy) when a slice
   * wouldn't pass its schema, since `defaults.json` would then reset that
   * board type to factory values on the next load. Nothing to write is a
   * no-op.
   */
  applyGlobal(): ApplyResult {
    const project = vaultStore.project;
    if (!project || !pending || !pendingBase) return { ok: true, changed: false };
    if (!this.hasGlobalChanges()) {
      pending = null;
      pendingBase = null;
      return { ok: true, changed: false };
    }
    const next = applyEdits(pendingBase, pending, sliceOf(project.settings)) as GlobalDefaults;
    for (const key of GLOBAL_DEFAULTS_KEYS) {
      const result = GLOBAL_DEFAULTS_SCHEMAS[key].safeParse(next[key]);
      if (!result.success) {
        return { ok: false, message: `Couldn't apply the Global Defaults: ${firstIssue(result.error, key)}` };
      }
    }
    project.settings = { ...project.settings, ...deepClone(next) };
    vaultStore.markMetaDirty();
    pending = null;
    pendingBase = null;
    return { ok: true, changed: true };
  },

  /**
   * Writes the Current Board copy to `pendingBoardId` (the board the session
   * started on, not whichever is active now). Refuses (keeping the copy)
   * when the settings wouldn't pass the board-file schema, since the board
   * would then fail to load. Goes through `boardCacheStore.updateBoardSettings`
   * (the single sink) and mirrors onto the active board for reactivity.
   */
  applyBoard(): ApplyResult {
    if (!pendingBoardSettings || !pendingBoardId || !pendingBoardBase) return { ok: true, changed: false };
    if (!this.hasBoardChanges()) {
      this.cancelBoard();
      return { ok: true, changed: false };
    }
    const live = liveBoardSettings(pendingBoardId) ?? {};
    const next = prune(applyEdits(pendingBoardBase, pendingBoardSettings, live)) as Record<string, unknown>;
    if (pendingBoardType) {
      const result = boardSettingsSchemaFor(pendingBoardType).safeParse(next);
      if (!result.success) {
        return { ok: false, message: `Couldn't apply the board settings: ${firstIssue(result.error, '')}` };
      }
    }
    const active = boardStore.current;
    boardCacheStore.updateBoardSettings(pendingBoardId, next);
    if (active && active.id === pendingBoardId) {
      (active as { settings: Record<string, unknown> }).settings = deepClone(next);
    }
    this.cancelBoard();
    return { ok: true, changed: true };
  },

  /** Discards the Global Defaults copy. */
  cancelGlobal(): void {
    pending = null;
    pendingBase = null;
  },

  /** Discards the Current Board copy. */
  cancelBoard(): void {
    pendingBoardSettings = null;
    pendingBoardBase = null;
    pendingBoardId = null;
    pendingBoardType = null;
  },

  /** Discards both copies without writing anything. */
  cancel(): void {
    this.cancelGlobal();
    this.cancelBoard();
  },
};

// Vault-swap reset: drops any unapplied session so a settings dialog still
// open during the swap doesn't write the previous vault's pending values
// into the new vault on a delayed Apply.
onVaultSwap('pre-swap', 'pendingSettings', () => {
  pendingSettingsStore.cancel();
});
