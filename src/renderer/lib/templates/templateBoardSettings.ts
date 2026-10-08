/**
 * A board template's own `"settings"` laid over a new board's.
 *
 * Each setting is taken only when it is one the board's type has and its
 * value passes the board's settings schema, so a template can never make a
 * board that won't load. Where the board keeps its notes (`defaultFolder`) is
 * Filo's choice for every new board, never a template's.
 */
import { z } from 'zod';
import { boardSettingsSchemaFor } from '../../schema/index';
import type { BoardType } from '../../../shared/types';

/** Settings a template may not set. */
const FILO_PLACED = new Set(['defaultFolder']);

export interface TemplateSettingsResult {
  settings: Record<string, unknown>;
  /** The template's settings left out: unknown to this board type, or a value it can't take. */
  refused: string[];
}

/** The settings a board of `type` has, by name (null when the schema isn't an object). */
function settingNames(type: BoardType): Set<string> | null {
  let schema: z.ZodType = boardSettingsSchemaFor(type);
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) {
    schema = schema.unwrap() as z.ZodType;
  }
  return schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : null;
}

export function withTemplateSettings(
  type: BoardType,
  base: Record<string, unknown>,
  wanted: Record<string, unknown>,
): TemplateSettingsResult {
  const schema = boardSettingsSchemaFor(type);
  const known = settingNames(type);
  let settings: Record<string, unknown> = { ...base };
  const refused: string[] = [];
  for (const [key, value] of Object.entries(wanted)) {
    if (FILO_PLACED.has(key) || (known && !known.has(key))) {
      refused.push(key);
      continue;
    }
    const next = { ...settings, [key]: value };
    if (schema.safeParse(next).success) settings = next;
    else refused.push(key);
  }
  return { settings, refused };
}
