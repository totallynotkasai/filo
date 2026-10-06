import { uiStore } from '../stores/ui.svelte';
import { noteStore } from '../stores/notes.svelte';
import type { FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { NoteGoneError } from './noteGoneError';
import { rebasePath, registerPathRenamable } from '../lib/vault/renamePathKeys';
import { NOTE_RENAME_GRACE_MS } from '../lib/vault/externalChangeWindows';

/**
 * Board undo of a note's frontmatter (a title, tags, a task or card field,
 * Properties). A command records the change as a `FrontmatterDelta` and the
 * delta that undoes it, taken from the note as it stood. Undo and redo send a
 * delta through the note writer, which applies it to a fresh read of the file,
 * so every key the command didn't touch keeps whatever it holds by then.
 *
 * One more check covers the keys it did touch: if another program changed
 * one of them since, the external value is kept (no silent clobber), the
 * other keys still apply, and an "Apply anyway" toast lets the user force it.
 */

/** Empty-equivalent under mergeFrontmatter's cleaning rule (absent === '' === null === undefined). */
function isEmptyish(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

/**
 * Order-independent structural deep-equality for frontmatter values. Used ONLY to
 * decide whether an external edit changed a field out from under an undo/redo —
 * NOT a byte-level "did the source change" test (that is `valuesEqual` in
 * frontmatterEngine, which is intentionally order-SENSITIVE because reordered
 * bytes must be rewritten).
 *
 * An external tool that merely REORDERS keys or items (e.g. an alphabetiser)
 * must not read as a conflict and skip the user's undo:
 *   • objects — same key set, values recursively equal (YAML/JSON object key order
 *     is never semantically meaningful);
 *   • arrays  — same MULTISET of items (DECISION: a pure reorder of a PKM list
 *     field like tags/aliases is not a conflict; duplicates still matter, so the
 *     lengths must match and each item is matched at most once). A genuinely
 *     ordered list that an external edit re-orders is the rare counter-case, and
 *     even then only its ordering — never an element — is lost on the undo.
 * The `depth` cap fails to `false` (the SAFE direction: treat as a conflict, keep
 * the external value) on pathological self-referential input.
 */
function fmDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 50) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const remaining = [...b];
    for (const item of a) {
      const idx = remaining.findIndex((candidate) => fmDeepEqual(item, candidate, depth + 1));
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    if (aKeys.length !== Object.keys(bo).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
      if (!fmDeepEqual(ao[key], bo[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Canonical equality for frontmatter values, matching `mergeFrontmatter`'s
 * cleaning rule (absent === '' === null === undefined) and comparing
 * arrays/objects structurally — and order-independently — so a re-emitted or
 * externally-reordered `tags: [...]` doesn't read as a spurious conflict.
 *
 * Exported for the Properties command, which works out the keys it owns
 * with the same predicate.
 */
export function fmValueEqual(a: unknown, b: unknown): boolean {
  if (isEmptyish(a) && isEmptyish(b)) return true;
  if (isEmptyish(a) || isEmptyish(b)) return false;
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return fmDeepEqual(a, b);
  }
  return false;
}

/**
 * The delta that undoes `delta` on a note whose frontmatter was `before`:
 * each key it touches goes back to its prior value, or is removed when the
 * note didn't have it. A key present with no value (`status:` or `due: ""`,
 * common in templates from other apps) comes back present and empty: the
 * writer keeps a `null` / `''` for a key the file holds.
 */
export function inverseDelta(
  before: Readonly<Record<string, unknown>>,
  delta: FrontmatterDelta,
): FrontmatterDelta {
  const inverse: FrontmatterDelta = { set: {}, unset: [] };
  for (const key of deltaKeys(delta)) {
    const prior = before[key];
    if (Object.prototype.hasOwnProperty.call(before, key) && prior !== undefined) inverse.set[key] = prior;
    else inverse.unset.push(key);
  }
  return inverse;
}

/** Every key `delta` touches. */
export function deltaKeys(delta: FrontmatterDelta): string[] {
  return [...Object.keys(delta.set), ...delta.unset];
}

/** The value `key` has once `delta` is applied (`undefined` when removed). */
function valueAfter(delta: FrontmatterDelta, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(delta.set, key) ? delta.set[key] : undefined;
}

/** The part of `delta` that touches `keys`. */
function pick(delta: FrontmatterDelta, keys: string[]): FrontmatterDelta {
  const wanted = new Set(keys);
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(delta.set)) if (wanted.has(k)) set[k] = v;
  return { set, unset: delta.unset.filter((k) => wanted.has(k)) };
}

export interface ApplyDeltaArgs {
  relPath: string;
  /** The delta applied this leg: the forward delta on redo, the inverse on undo. */
  delta: FrontmatterDelta;
  /**
   * The opposite leg: what each touched key holds if nothing external changed
   * it (the forward delta for undo, the inverse for redo).
   */
  expected: FrontmatterDelta;
  /** Label for the conflict toast (the note path). */
  label: string;
  /**
   * Treat the delta as one unit on a conflict. A recurrence roll-forward
   * writes `{ completed: false, dueDate: next }` together; applying one key
   * and keeping the other external could produce `completed: true` with an
   * advanced `dueDate`, a state the roll-forward must never create. When true,
   * ANY conflict skips the WHOLE delta and offers an all-or-nothing "Apply
   * anyway". Omitted/false: the per-key merge below (right for independent
   * multi-field edits like the Document tab's tag row).
   */
  atomic?: boolean;
  /**
   * When the note is on disk but can't be read: `apply` sends the delta
   * anyway (a lock that clears later still lets it land; the writer reports a
   * write it can't land); `throw` rejects so history keeps the command where
   * it was. Default `apply`. A note that is gone always rejects with
   * `NoteGoneError`: a write to a missing file can't land.
   */
  whenUnreadable?: 'apply' | 'throw';
}

/** Whether the note's file exists: true / false, or null when the probe had no answer. */
async function noteExists(relPath: string): Promise<boolean | null> {
  const vaultRoot = getActiveVaultPath();
  if (!vaultRoot) return null;
  try {
    const exists = await window.filo.invoke('vault:file-exists', vaultRoot, relPath);
    return typeof exists === 'boolean' ? exists : null;
  } catch {
    return null;
  }
}

// allow-module-state: a counter that only makes each wait's sweep name unique
let renameWaits = 0;

/**
 * Waits up to `NOTE_RENAME_GRACE_MS` for a rename that moves `relPath`
 * (the note, or a folder above it): its new path, or null when none came.
 */
function waitForRename(relPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const name = `applyDeltaChecked.waitForRename:${++renameWaits}`;
    const finish = (moved: string | null): void => {
      clearTimeout(timer);
      unregister();
      resolve(moved);
    };
    const unregister = registerPathRenamable(name, (oldRel, newRel) => {
      const moved = rebasePath(relPath, oldRel, newRel);
      if (moved !== null) finish(moved);
    });
    const timer = setTimeout(() => finish(null), NOTE_RENAME_GRACE_MS);
  });
}

/**
 * Applies `delta` to the note, except any key another program changed since
 * the opposite leg left it (that one keeps the external value, with an "Apply
 * anyway" toast). The change goes to the note writer as a delta; no board
 * file is written for it.
 *
 * The compare base is a fresh read of the file with any queued change laid
 * over it, even when the note is open: its model catches up with another
 * program's save only after the watcher's debounce.
 */
export async function applyDeltaChecked(args: ApplyDeltaArgs, mayWaitForRename = true): Promise<void> {
  const { relPath, delta, expected, label, atomic } = args;

  // Captured ONCE and consulted by the "Apply anyway" handlers: a click after
  // a vault swap must not queue this delta onto the NEW vault's same-named
  // file (the writer resolves its vault root live). Also guards the read.
  const identity = captureVaultIdentity();

  // Only the note changes: no board holds its fields, so no board file is
  // written for it (KNOWN_LIMITATIONS #29).
  const commit = (part: FrontmatterDelta, path: string = relPath): void => {
    noteStore.patchFrontmatter(path, part);
  };

  const current = await noteStore.currentFrontmatter(relPath, { fromDisk: true });
  if (!isStillSameVault(identity)) return;
  // Asked even when the note's model answered: for a second or two after
  // another program deletes the file (the watcher's missing-file hold, then
  // the model's own check), the model still holds its last frontmatter, and a
  // delta queued then can only fail as a write to a file that's gone.
  // Only a definite "not there" counts as gone; an unanswered probe is
  // treated as present, the side that never drops the change.
  if ((await noteExists(relPath)) === false) {
    if (!mayWaitForRename) {
      if (!isStillSameVault(identity)) return;
      throw new NoteGoneError(relPath);
    }
    // Missing may mean mid-rename by another program: the rename arrives as
    // its own event a moment later. Wait it out; a rename re-points the step
    // (the history sweep moves the command's paths) and it applies there. A
    // note still missing after the grace is gone: nothing is queued for it.
    const moved = await waitForRename(relPath);
    if (!isStillSameVault(identity)) return;
    // Once more, at the new path or (a sync client's replace) the old one;
    // missing again there, it is gone.
    await applyDeltaChecked(moved !== null ? { ...args, relPath: moved } : args, false);
    return;
  }
  if (!isStillSameVault(identity)) return;
  if (current === null) {
    if (args.whenUnreadable === 'throw') {
      throw new Error(`Could not read ${relPath} to apply the change.`);
    }
    // Present but unreadable: no baseline to detect a conflict against, and
    // nothing visible to lose. The writer reports a write it can't land.
    commit(delta);
    return;
  }

  const keys = deltaKeys(delta);
  const conflicts = keys.filter((key) => !fmValueEqual(current[key], valueAfter(expected, key)));
  if (conflicts.length === 0) {
    commit(delta);
    return;
  }

  // The toast may wait a while: "Apply anyway" writes the note wherever a
  // rename (in Filo or by another program) has moved it by then.
  const pending = followRenames(relPath);
  const applyAnyway = (part: FrontmatterDelta) => (): void => {
    pending.stop();
    if (!isStillSameVault(identity)) return;
    commit(part, pending.path());
  };

  if (atomic) {
    // A coupled pair (recurrence roll-forward): apply NOTHING and offer to
    // force the whole delta.
    uiStore.pushToast({
      text: `External edit changed ${conflicts.join(', ')} in ${label}. Skipped this undo/redo to keep the recurring task consistent.`,
      type: 'warning',
      duration: 0,
      actions: [{ label: 'Apply anyway', handler: applyAnyway(delta) }],
    });
    return;
  }

  // Keep the external value(s); apply only the keys nothing external touched.
  const safe = keys.filter((key) => !conflicts.includes(key));
  if (safe.length > 0) commit(pick(delta, safe));

  uiStore.pushToast({
    text: `External edit changed ${conflicts.join(', ')} in ${label}. Kept the external value — that field's undo/redo was skipped.`,
    type: 'warning',
    duration: 0,
    actions: [{ label: 'Apply anyway', handler: applyAnyway(pick(delta, conflicts)) }],
  });
}

// allow-module-state: a counter that only makes each follower's sweep name unique
let renameFollowers = 0;

/**
 * `relPath` kept current across renames until `stop()`. The sweep also stops
 * itself once the vault it was taken in is gone, so a toast left unanswered
 * holds nothing past a vault swap.
 */
function followRenames(relPath: string): { path: () => string; stop: () => void } {
  let current = relPath;
  const identity = captureVaultIdentity();
  const name = `applyDeltaChecked.applyAnyway:${++renameFollowers}`;
  const stop = registerPathRenamable(name, (oldRel, newRel) => {
    if (!isStillSameVault(identity)) {
      stop();
      return;
    }
    current = rebasePath(current, oldRel, newRel) ?? current;
  });
  return { path: () => current, stop };
}
