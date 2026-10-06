/**
 * A step on a flat record (a style block, a saved view) kept as the keys it
 * changed. Undo and redo change only those keys on the record as it stands,
 * so a key changed meanwhile by anything else keeps its newer value: a size
 * cleared by "Use Default Font Sizes for all Existing Items" stays cleared
 * when an older colour change is undone, and a tag a vault-wide rename
 * rewrote in a saved view stays renamed.
 */

type Block = Record<string, unknown>;

export interface KeyDelta {
  /** Keys the step gave a value, with that value. */
  set: Block;
  /** Keys the step removed. */
  unset: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The keys that differ between `from` and `to` (an `undefined` value counts as absent). */
export function keyDelta(from: Block | null | undefined, to: Block | null | undefined): KeyDelta {
  const a = from ?? {};
  const b = to ?? {};
  const set: Block = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(b)) {
    if (value !== undefined && !same(a[key], value)) set[key] = value;
  }
  for (const [key, value] of Object.entries(a)) {
    if (value !== undefined && b[key] === undefined) unset.push(key);
  }
  return { set, unset };
}

/** True when the delta changes nothing. */
export function isEmptyKeyDelta(delta: KeyDelta): boolean {
  return delta.unset.length === 0 && Object.keys(delta.set).length === 0;
}

/** `current` with `delta` applied, as a new record (values detached from the delta). */
export function applyKeyDelta(current: Block | null | undefined, delta: KeyDelta): Block {
  const next: Block = { ...(current ?? {}) };
  for (const key of delta.unset) delete next[key];
  for (const [key, value] of Object.entries(delta.set)) next[key] = JSON.parse(JSON.stringify(value)) as unknown;
  return next;
}
