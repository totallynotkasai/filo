/**
 * Pure helpers for CurrentBoard* settings panels. The per-type panels
 * (CurrentBoardMindMap, ...Kanban, ...TaskList, ...Document) each call
 * these to read/write the active board's per-board override layer
 * (`board.settings.defaults.*`) through `pendingSettingsStore`.
 *
 * Empty inputs (string `''` / undefined) clear the override so the
 * field falls through to the global default in the cascade.
 */
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { boardSettingsSchemaFor } from '../../schema/index';
import { numberBoundsAt, readNumberField } from './numberInput';

export function readPath(settings: unknown, path: string): unknown {
  if (!settings) return undefined;
  const parts = path.split('.');
  let cursor: unknown = settings;
  for (const p of parts) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

export function updatePath(path: string, value: unknown): void {
  pendingSettingsStore.updateBoard(path, value);
}

export function formatBoolean(v: unknown): string {
  if (v === true) return 'true';
  if (v === false) return 'false';
  return '';
}

export function parseBoolean(v: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * Commits a Current Board number field. Blank clears the override; any
 * other entry is clamped to the board-file schema's range for that field
 * (read from the schema, so a saved value always loads again).
 */
export function updateNumberOrInherit(path: string, input: HTMLInputElement): void {
  const type = pendingSettingsStore.pendingBoardType;
  if (!type) return;
  const lastGood = readPath(pendingSettingsStore.effectiveBoardSettings, path);
  const value = readNumberField(
    input,
    numberBoundsAt(boardSettingsSchemaFor(type), path),
    typeof lastGood === 'number' ? lastGood : undefined,
    true,
  );
  updatePath(path, value);
}
