/**
 * rawViews — every mounted raw view of a note, so text typed there counts as
 * unsaved work.
 *
 * A raw view holds its text in component state until it saves (once typing
 * pauses, on blur, Ctrl+S, switching back, closing). Nothing else in the app
 * can see that text, so without this registry quit (which never unmounts the view) and
 * close / open-another-vault (which unmount it after checking for unsaved
 * work) would let it go silently. Registered views are:
 *  - reported to `unsavedWork()`, so the leave and quit dialogs name them;
 *  - flushed by `flushRawViews()` from the vault save and before a tab closes;
 *  - copied whole into `.filo/recovery/` by the rescue path when they still
 *    can't be written;
 *  - while one shows its conflict banner, held as a decision
 *    (`noteRawConflict`), so the save indicator lists it and quit says it is
 *    waiting for an answer rather than that the save failed.
 */
import { vaultPath } from '@shared/vaultPath';
import { registerArmedPathSource, registerUnsavedSource } from '../boards/writeStateTracking';
import { getActiveVaultPath } from '../vault/activeVaultPath';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { uiStore } from '../../stores/ui.svelte';
import { holdDecision, releaseDecision } from '../../stores/heldDecisions';

/**
 * - `clean`: nothing typed that isn't on disk.
 * - `saved`: the typed text is now on disk.
 * - `conflict`: the note changed elsewhere since the view read it; not written.
 * - `failed`: the write failed; not written.
 */
export type RawSaveResult = 'clean' | 'saved' | 'conflict' | 'failed';

export interface RawViewHandle {
  /** The note's vault path (followed on rename by the view's prop). */
  path(): string;
  /** True while the view holds text that isn't on disk. */
  isDirty(): boolean;
  /** True while the view shows its conflict banner. */
  inConflict(): boolean;
  /** The whole file as typed (LF, no BOM). */
  text(): string;
  /** Writes what is typed, if it can. */
  flush(): Promise<RawSaveResult>;
  /**
   * A rescue copy of `text` was kept for a leave or quit going ahead: the
   * view must not write that same text into the vault being let go. Text
   * typed after it is new and saves as usual.
   */
  markRescued(text: string): void;
  /** The leave or quit was called off: the view saves its text again. */
  clearRescued(): void;
  /** Brings the view's text field into view and focuses it. */
  focus(): void;
}

// allow-module-state: holds mounted views only; each removes itself on unmount, which a vault swap causes
const views = new Set<RawViewHandle>();

/** Adds a mounted raw view; the returned function removes it. */
export function registerRawView(handle: RawViewHandle): () => void {
  views.add(handle);
  return () => {
    views.delete(handle);
    releaseDecision(rawDecisionKey(handle));
  };
}

// allow-module-state: a counter for decision keys; the keys go with their views
let nextRawDecisionId = 1;
// allow-module-state: weakly keyed by mounted views, which a vault swap unmounts
const rawDecisionKeys = new WeakMap<RawViewHandle, string>();

/** One decision key per mounted view, stable across renames of its note. */
function rawDecisionKey(handle: RawViewHandle): string {
  let key = rawDecisionKeys.get(handle);
  if (!key) {
    key = `raw-conflict:${nextRawDecisionId++}`;
    rawDecisionKeys.set(handle, key);
  }
  return key;
}

/**
 * The view's conflict banner came up (`inConflict`) or was answered. While
 * it is up, the typed text can't be written by any save or retry, only by
 * the user's answer, so it is held as a decision; `reopen` focuses the view.
 */
export function noteRawConflict(handle: RawViewHandle, inConflict: boolean): void {
  const key = rawDecisionKey(handle);
  if (!inConflict) {
    releaseDecision(key);
    return;
  }
  holdDecision({
    key,
    relPath: () => handle.path(),
    text: 'Changed while you were editing it as text: Use the new version or Keep mine',
    stillHeld: () => views.has(handle) && handle.inConflict(),
    reopen: () => handle.focus(),
  });
}

// A dirty raw view keeps its path pending, so another writer finishing a
// write of the same note never clears the save indicator or the sentinel.
registerArmedPathSource((key) => dirtyRawViews().some((v) => vaultPath(v.path()) === key));

/** Mounted raw views holding text that isn't on disk. */
export function dirtyRawViews(): RawViewHandle[] {
  return [...views].filter((v) => v.isDirty());
}

/** True when a mounted raw view of `path` shows its conflict banner with text unsaved. */
export function rawViewInConflict(path: string): boolean {
  const key = vaultPath(path);
  return dirtyRawViews().some((v) => vaultPath(v.path()) === key && v.inConflict());
}

/**
 * Saves every dirty raw view (or only those of `paths`). Resolves with the
 * paths whose text still isn't on disk.
 */
export async function flushRawViews(paths?: readonly string[]): Promise<{ notSaved: string[] }> {
  const keys = paths ? new Set(paths.map((p) => vaultPath(p))) : null;
  const notSaved: string[] = [];
  for (const view of [...views]) {
    if (keys && !keys.has(vaultPath(view.path()))) continue;
    let result: RawSaveResult;
    try {
      result = await view.flush();
    } catch {
      result = 'failed';
    }
    if (result === 'conflict' || result === 'failed') notSaved.push(view.path());
  }
  return { notSaved };
}

/** The raw views' part of a rescue: the items to copy, and what to do once they are. */
export interface RawRescue {
  items: Array<{ relPath: string; text: string }>;
  /**
   * The copies of `keptPaths` were written: those views stop saving the
   * rescued text. A view whose copy failed still saves on teardown.
   */
  commit(keptPaths: readonly string[]): void;
}

/**
 * The text of every dirty raw view, as rescue items. Nothing is marked until
 * `commit`: a rescue that fails, or a leave the user then calls off, must
 * leave every view saving as before.
 */
export function takeRawRescueItems(): RawRescue {
  const taken = dirtyRawViews().map((view) => ({ view, relPath: view.path(), text: view.text() }));
  return {
    items: taken.map(({ relPath, text }) => ({ relPath, text })),
    commit(keptPaths) {
      const kept = new Set(keptPaths.map((p) => vaultPath(p)));
      for (const t of taken) {
        if (kept.has(vaultPath(t.relPath))) t.view.markRescued(t.text);
      }
    },
  };
}

/**
 * A leave or quit that kept rescue copies was called off (or failed): every
 * mounted raw view saves its text again, so closing its tab later neither
 * skips the save nor the copy.
 */
export function rollbackRawRescues(): void {
  for (const view of views) view.clearRescued();
}

/**
 * A raw view closed with text it couldn't write: keep a copy in
 * `.filo/recovery/` and say where, so nothing typed disappears without a
 * trace. Returns false when even the copy couldn't be written (the toast says
 * so). `because` words a more specific reason than `why` gives.
 */
export async function keepRawRescueCopy(path: string, text: string, why: RawSaveResult, because?: string): Promise<boolean> {
  const vaultRoot = getActiveVaultPath();
  const reason = because ?? (why === 'conflict' ? 'because the note changed elsewhere' : "because they couldn't be saved");
  if (vaultRoot) {
    try {
      const kept = await invokeOk('recovery:keep-unsaved', vaultRoot, [{ relPath: path, text }]);
      if (kept.kept.length > 0) {
        const dirAbs = `${vaultRoot.replace(/[\\/]$/, '')}/${kept.dir}`;
        uiStore.pushToast({
          text: `Your raw edits to "${path}" were kept in ${kept.dir}/ ${reason}.`,
          type: 'warning',
          sticky: true,
          actions: [{ label: 'Reveal', handler: () => void window.filo.invoke('shell:show-item-in-folder', dirAbs) }],
        });
        return true;
      }
    } catch (err) {
      reportError('rawView.rescue', err, `Couldn't keep a copy of the raw edits to "${path}"`);
    }
  }
  uiStore.pushToast({
    text: `Your raw edits to "${path}" couldn't be saved ${reason}, and Filo couldn't keep a copy of them.`,
    type: 'error',
    sticky: true,
  });
  return false;
}

registerUnsavedSource(() => dirtyRawViews().map((v) => v.path()));
