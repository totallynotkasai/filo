import type { ProjectSettings } from '../schema/index';
import { vaultStore } from './vault.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Key-sorted JSON used by `hasUnsavedChanges`: two settings trees compare
 * equal iff every (path, value) pair matches, regardless of key insertion
 * order. Cheap given the small settings tree.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Pending-settings store — backs the Settings modal's Apply/Cancel UX.
 *
 * Two scopes are tracked in parallel:
 *
 *   - Global defaults (`pending`) — a deep clone of
 *     `vaultStore.project.settings` that the Global tab edits.
 *   - Current board (`pendingBoardSettings`) — a deep clone of the
 *     active board's `settings` block (including the per-board
 *     `defaults` cascade override). The
 *     Current Board tab edits this.
 *
 * Components that want to honour the pending session read from
 * `pendingSettingsStore.effective` / `effectiveBoardSettings`. Both
 * return the editable copy during a session and the live values
 * otherwise, so the same controls work inside and outside the modal.
 *
 * `apply()` writes both copies back to their respective stores and
 * marks metadata / board dirty (which schedules debounced writes).
 * `cancel()` discards both.
 */

let pending = $state<ProjectSettings | null>(null);
let pendingBoardSettings = $state<Record<string, unknown> | null>(null);
let pendingBoardId = $state<string | null>(null);

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setNestedField(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue; // i < parts.length - 1; narrow for the type-checker
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      // Create intermediate objects on-the-fly so the user can set a
      // nested field like `defaults.tile.headerColor` even when the
      // board's settings.defaults block doesn't exist yet.
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey !== undefined) cursor[lastKey] = value; // split() always yields >= 1 part
}

export const pendingSettingsStore = {
  /** Whether an Apply/Cancel session is currently in progress. */
  get active(): boolean {
    return pending !== null || pendingBoardSettings !== null;
  },

  /**
   * True when the active session has edits that diverge from
   * the live store values. Drives the modal's discard-changes confirmation:
   * a session with no diff (e.g. just opened the modal, or applied/cancelled
   * before closing) doesn't pester the user. Compares both scopes:
   *
   *  - global pending vs `vaultStore.project.settings`
   *  - board pending vs the cached board's `settings` (looked up by
   *    `pendingBoardId` so a tab-switch during the session doesn't drift
   *    the comparison onto the wrong board)
   *
   * Uses a stable JSON serialisation so key-order is irrelevant — the
   * settings tree is small enough that the cost is negligible.
   */
  hasUnsavedChanges(): boolean {
    if (pending !== null) {
      const live = vaultStore.project?.settings;
      if (live && stableStringify(pending) !== stableStringify(live)) return true;
    }
    if (pendingBoardSettings !== null && pendingBoardId !== null) {
      // Prefer the cache lookup (authoritative + survives a tab switch);
      // fall back to the active board if the cache doesn't have an entry.
      const cached = boardCacheStore.cache[pendingBoardId];
      const liveSettings =
        (cached?.board.settings as Record<string, unknown> | undefined) ??
        (boardStore.current?.id === pendingBoardId
          ? (boardStore.current.settings as Record<string, unknown>)
          : undefined);
      if (
        liveSettings &&
        stableStringify(pendingBoardSettings) !== stableStringify(liveSettings)
      ) {
        return true;
      }
    }
    return false;
  },

  // ── Global settings ────────────────────────────────────────────────

  get pending(): ProjectSettings | null {
    return pending;
  },

  /**
   * Returns the global settings the UI should currently render against.
   */
  get effective(): ProjectSettings | null {
    if (pending) return pending;
    return vaultStore.project?.settings ?? null;
  },

  // ── Board settings ─────────────────────────────────────────────────

  get pendingBoardSettings(): Record<string, unknown> | null {
    return pendingBoardSettings;
  },

  get pendingBoardId(): string | null {
    return pendingBoardId;
  },

  /**
   * Returns the current board's settings (including the `defaults`
   * override block). Inside a session this is the editable copy;
   * otherwise it reads straight from the active board.
   */
  get effectiveBoardSettings(): Record<string, unknown> | null {
    if (pendingBoardSettings) return pendingBoardSettings;
    const board = boardStore.current;
    return (board?.settings as Record<string, unknown>) ?? null;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Snapshots only the global ProjectSettings into `pending`. Used to
   * (re-)arm the Global Defaults tab without disturbing any
   * uncommitted Current Board edits in `pendingBoardSettings`.
   */
  startGlobal(): void {
    const live = vaultStore.project?.settings;
    if (live) pending = deepClone(live);
  },

  /**
   * Snapshots only the active board's settings into
   * `pendingBoardSettings`. Used to (re-)arm the Current Board tab
   * without disturbing any uncommitted Global Defaults edits in
   * `pending`.
   */
  startBoard(): void {
    const board = boardStore.current;
    if (board) {
      pendingBoardId = board.id;
      pendingBoardSettings = deepClone(board.settings as Record<string, unknown>);
    }
  },

  /**
   * Begins a session by snapshotting both scopes. Used by the modal's
   * mount effect. Per-tab Apply/Cancel must re-arm only the scope they
   * just committed (`startGlobal` / `startBoard`) — calling this here
   * would wipe whatever is still pending in the other tab.
   */
  start(): void {
    this.startGlobal();
    this.startBoard();
  },

  /**
   * Mutates a field at a dotted path in the global pending copy.
   *
   * We deep-clone before each write so the top-level reference changes
   * AND every nested object on the path is a fresh reference. This is
   * what wakes up `$derived` consumers reading deep paths
   * (LivePreview, ColorPicker `value` props on nested fields) — a
   * shallow `{ ...pending }` only touches the top-level object and
   * leaves nested references stable, which can starve nested reads.
   */
  update(path: string, value: unknown): void {
    if (!pending) return;
    const next = deepClone(pending);
    // ProjectSettings is a `.passthrough()` schema output, so its inferred
    // type already carries an index signature compatible with the loose
    // `Record<string, unknown>` shape that `setNestedField` walks.
    setNestedField(next, path, value);
    pending = next;
  },

  /**
   * Mutates a field at a dotted path in the board pending copy.
   * Same deep-clone rationale as `update`.
   */
  updateBoard(path: string, value: unknown): void {
    if (!pendingBoardSettings) return;
    const next = deepClone(pendingBoardSettings);
    setNestedField(next, path, value);
    pendingBoardSettings = next;
  },

  /**
   * Commits the global pending copy only. Used by the per-tab Apply
   * inside `BoardDefaults.svelte`.
   */
  applyGlobal(): void {
    const project = vaultStore.project;
    if (project && pending) {
      project.settings = deepClone(pending);
      vaultStore.markMetaDirty();
    }
    pending = null;
  },

  /**
   * Commits the board pending copy only. Used by the per-tab Apply
   * inside `CurrentBoardSettings.svelte`.
   *
   * Targets `pendingBoardId` (the board that was active when the session
   * started), NOT `boardStore.current.id`, so switching tabs while the
   * modal is open doesn't write the snapshotted settings to the wrong
   * board. Writes through `boardCacheStore.updateBoardSettings` (the
   * single sink) and mirrors onto the active proxy for immediate
   * reactivity — same contract as `boardStore.updateSettings`.
   */
  applyBoard(): void {
    if (pendingBoardSettings && pendingBoardId) {
      const next = deepClone(pendingBoardSettings);
      const active = boardStore.current;
      boardCacheStore.updateBoardSettings(pendingBoardId, next);
      if (active && active.id === pendingBoardId) {
        (active as { settings: Record<string, unknown> }).settings = next;
      }
    }
    pendingBoardSettings = null;
    pendingBoardId = null;
  },

  /**
   * Commits both pending copies atomically.
   */
  apply(): void {
    this.applyGlobal();
    this.applyBoard();
  },

  /**
   * Discards the global pending copy only.
   */
  cancelGlobal(): void {
    pending = null;
  },

  /**
   * Discards the board pending copy only.
   */
  cancelBoard(): void {
    pendingBoardSettings = null;
    pendingBoardId = null;
  },

  /**
   * Discards both pending copies without writing anything.
   */
  cancel(): void {
    pending = null;
    pendingBoardSettings = null;
    pendingBoardId = null;
  },
};

// Vault-swap reset: drops any uncommitted Apply/Cancel session so a settings modal still
// open during the swap doesn't write the previous vault's pending values
// into the new vault's board on a delayed Apply.
onVaultSwap('pre-swap', 'pendingSettings', () => {
  pendingSettingsStore.cancel();
});
