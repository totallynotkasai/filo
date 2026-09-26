/**
 * Number fields in the Settings dialog.
 *
 * An `<input type="number">`'s `min` / `max` don't stop a typed value, and
 * a bare `parseInt` turns an empty field into `NaN`. Either one, saved, fails
 * the schema on the next load: a board file stops loading, or a whole
 * `defaults.json` slice resets to factory values. So every settings number
 * goes through here: its range is read from the Zod schema that later
 * validates it (never a copied constant), a value outside it is clamped, and
 * an entry that isn't a number puts the field back to its last good value.
 */
import { z } from 'zod';

export interface NumberBounds {
  min: number;
  max: number;
  int: boolean;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  while (
    s instanceof z.ZodOptional ||
    s instanceof z.ZodDefault ||
    s instanceof z.ZodPrefault ||
    s instanceof z.ZodNullable
  ) {
    s = s.unwrap() as z.ZodType;
  }
  return s;
}

/**
 * The range of the number field at a dotted `path` in an object schema.
 * Throws when the path doesn't name a number, since that is a typo in the
 * caller, not something a user can cause.
 */
export function numberBoundsAt(schema: z.ZodType, path: string): NumberBounds {
  let cursor = unwrap(schema);
  for (const key of path.split('.')) {
    if (!(cursor instanceof z.ZodObject)) throw new Error(`numberBoundsAt: "${path}" is not in the schema`);
    const next = (cursor.shape as Record<string, z.ZodType | undefined>)[key];
    if (!next) throw new Error(`numberBoundsAt: "${path}" is not in the schema`);
    cursor = unwrap(next);
  }
  if (!(cursor instanceof z.ZodNumber)) throw new Error(`numberBoundsAt: "${path}" is not a number`);
  return {
    min: cursor.minValue ?? -Infinity,
    max: cursor.maxValue ?? Infinity,
    int: cursor.isInt ?? false,
  };
}

/**
 * Parses `raw` into a value inside `bounds`. Anything that isn't a finite
 * number gives `fallback`; a number outside the range is clamped; an integer
 * field is rounded.
 */
export function numberInput<F extends number | undefined>(
  raw: string,
  bounds: NumberBounds,
  fallback: F,
): number | F {
  const trimmed = raw.trim();
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = bounds.int ? Math.round(parsed) : parsed;
  return Math.min(bounds.max, Math.max(bounds.min, rounded));
}

/**
 * Reads a settings number field and makes it show what will be saved.
 *
 * - `optional` and blank: returns `undefined` (clear the override / inherit).
 * - not a number: returns `lastGood` and puts it back in the field.
 * - out of range: returns the clamped value and shows it.
 *
 * A browser reports an unparsable `type="number"` entry as `''`, so for an
 * optional field that also reads as "clear"; for a required one it snaps back.
 */
export function readNumberField(
  input: HTMLInputElement,
  bounds: NumberBounds,
  lastGood: number | undefined,
  optional: boolean,
): number | undefined {
  if (optional && input.value.trim() === '') return undefined;
  const value = numberInput(input.value, bounds, lastGood);
  input.value = value === undefined ? '' : String(value);
  return value;
}
