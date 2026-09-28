/**
 * Field-by-field parsing for a settings slice read from `.filo/app.json` or
 * `.filo/defaults.json`.
 *
 * One bad value (a font size out of range, an enum value a newer Filo added)
 * must not reset the whole slice: the next settings save writes the slice
 * back, so every other value in the file would be lost with it. Each field
 * that fails falls back to its default alone, and keys this build doesn't
 * know (a newer Filo's settings) are carried through so the save keeps them.
 */
import type { z } from 'zod';

export interface SalvagedSlice<T> {
  data: T;
  /** Dotted paths of the fields that fell back to their default. */
  reset: string[];
}

/** Bounds the salvage loop: every round drops at least one field. */
const MAX_ROUNDS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Removes the field an issue points at, so its default applies. An issue
 * inside an array (one bad colour in a list) drops the whole array: a list
 * with a hole would still be the user's list, just wrong. Returns the dotted
 * path removed, or null when there is nothing left to remove.
 */
function dropIssueField(root: Record<string, unknown>, path: readonly PropertyKey[]): string | null {
  let container: Record<string, unknown> = root;
  let dropKey: string | null = null;
  let dropFrom: Record<string, unknown> | null = null;
  const walked: string[] = [];
  for (const segment of path) {
    if (typeof segment !== 'string' || !(segment in container)) break;
    dropKey = segment;
    dropFrom = container;
    walked.push(segment);
    const next = container[segment];
    if (!isPlainObject(next)) break;
    container = next;
  }
  if (dropKey === null || dropFrom === null) return null;
  delete dropFrom[dropKey];
  return walked.join('.');
}

/**
 * Copies every key of `input` the parsed `data` lacks: the schema strips
 * keys it doesn't know, and the save must keep them.
 */
function carryUnknownKeys(data: Record<string, unknown>, input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (!(key in data)) {
      data[key] = value;
    } else if (isPlainObject(data[key]) && isPlainObject(value)) {
      carryUnknownKeys(data[key] as Record<string, unknown>, value);
    }
  }
}

/**
 * Parses `input` with `schema`, dropping each field that fails so it takes
 * its default, and keeping unknown keys. `prefix` names the slice in the
 * reset paths (`kanban.card.borderWidth`).
 */
export function salvageSlice<S extends z.ZodType>(
  schema: S,
  input: unknown,
  prefix = '',
): SalvagedSlice<z.infer<S>> {
  const reset: string[] = [];
  const first = schema.safeParse(input);
  if (first.success) {
    if (isPlainObject(first.data) && isPlainObject(input)) {
      carryUnknownKeys(first.data, input);
    }
    return { data: first.data, reset };
  }
  // A copy: the caller's object may be live state, and JSON is all a
  // settings file can hold.
  let work: unknown = isPlainObject(input) ? JSON.parse(JSON.stringify(input)) : {};
  if (!isPlainObject(input)) reset.push(prefix || '(all)');
  let result = schema.safeParse(work);
  for (let round = 0; !result.success && round < MAX_ROUNDS; round++) {
    let dropped = false;
    for (const issue of result.error.issues) {
      const removed = isPlainObject(work) ? dropIssueField(work, issue.path) : null;
      if (removed !== null) {
        reset.push(prefix ? `${prefix}.${removed}` : removed);
        dropped = true;
      }
    }
    if (!dropped) break;
    result = schema.safeParse(work);
  }
  if (!result.success) {
    // Nothing left to drop and it still fails: the whole slice takes its defaults.
    work = {};
    result = schema.safeParse(work);
    reset.push(prefix || '(all)');
    if (!result.success) throw result.error;
  }
  if (isPlainObject(result.data) && isPlainObject(work)) {
    carryUnknownKeys(result.data, work);
  }
  return { data: result.data, reset: [...new Set(reset)] };
}
