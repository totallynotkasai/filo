/**
 * Settings number fields: the range comes from the schema that validates
 * the value later, a typed value outside it is clamped, and a non-number
 * snaps the field back. Also checks that every number field path the
 * settings components name exists in its schema, since a typo there would
 * only show up as a throw when the user edits that field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { numberBoundsAt, numberInput, readNumberField } from '@renderer/lib/settings/numberInput';
import { GeneralSettingsSchema, ProjectSettingsSchema } from '@renderer/schema/settings';
import { boardSettingsSchemaFor } from '@renderer/schema/index';

const SETTINGS_DIR = join(__dirname, '../../renderer/components/settings');

function input(value: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value;
  return el;
}

describe('numberBoundsAt', () => {
  it('reads a required field through prefault / default wrappers', () => {
    expect(numberBoundsAt(ProjectSettingsSchema, 'mindmap.tile.borderWidth')).toEqual({ min: 0, max: 10, int: false });
  });

  it('reads an optional field', () => {
    expect(numberBoundsAt(ProjectSettingsSchema, 'mindmap.connectionLabel.fontSize')).toEqual({ min: 8, max: 32, int: false });
  });

  it('reports an integer field', () => {
    expect(numberBoundsAt(GeneralSettingsSchema, 'historyLimit')).toEqual({ min: 10, max: 5000, int: true });
  });

  it('reads a board-file settings field', () => {
    expect(numberBoundsAt(boardSettingsSchemaFor('kanban'), 'defaults.column.width')).toEqual({ min: 120, max: 2000, int: false });
  });

  it('throws for a path that is not a number field', () => {
    expect(() => numberBoundsAt(ProjectSettingsSchema, 'mindmap.tile.nope')).toThrow();
    expect(() => numberBoundsAt(ProjectSettingsSchema, 'mindmap.tile.shape')).toThrow();
  });
});

describe('numberInput', () => {
  const bounds = { min: 0, max: 10, int: false };

  it('clamps to the range', () => {
    expect(numberInput('50', bounds, 1)).toBe(10);
    expect(numberInput('-3', bounds, 1)).toBe(0);
  });

  it('gives the fallback for a blank or non-number entry', () => {
    expect(numberInput('', bounds, 4)).toBe(4);
    expect(numberInput('abc', bounds, 4)).toBe(4);
    expect(numberInput('Infinity', bounds, 4)).toBe(4);
  });

  it('rounds an integer field', () => {
    expect(numberInput('12.6', { min: 10, max: 5000, int: true }, 500)).toBe(13);
  });
});

describe('readNumberField', () => {
  const bounds = { min: 10, max: 20, int: true };

  it('shows the clamped value in the field', () => {
    const el = input('25');
    expect(readNumberField(el, bounds, 13, false)).toBe(20);
    expect(el.value).toBe('20');
  });

  it('snaps a required field back to its last good value', () => {
    const el = input('');
    expect(readNumberField(el, bounds, 13, false)).toBe(13);
    expect(el.value).toBe('13');
  });

  it('clears an optional field left blank', () => {
    const el = input('');
    expect(readNumberField(el, bounds, 13, true)).toBeUndefined();
  });
});

describe('every settings number field names a real schema field', () => {
  function pathsIn(file: string, pattern: RegExp): string[] {
    const src = readFileSync(join(SETTINGS_DIR, file), 'utf8');
    return [...src.matchAll(pattern)].map((m) => m[1] ?? '');
  }

  it('Global Defaults', () => {
    const paths = pathsIn('BoardDefaults.svelte', /setNumber\(e\.currentTarget, '([^']+)'/g);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(() => numberBoundsAt(ProjectSettingsSchema, p), p).not.toThrow();
  });

  it('Current Board', () => {
    const byFile: Record<string, 'mindmap' | 'kanban' | 'tasklist' | 'document'> = {
      'CurrentBoardMindMap.svelte': 'mindmap',
      'CurrentBoardKanban.svelte': 'kanban',
      'CurrentBoardTaskList.svelte': 'tasklist',
      'CurrentBoardDocument.svelte': 'document',
    };
    const files = readdirSync(SETTINGS_DIR).filter((f) => f.startsWith('CurrentBoard') && f !== 'CurrentBoardSettings.svelte');
    expect(files.sort()).toEqual(Object.keys(byFile).sort());
    for (const file of files) {
      const type = byFile[file];
      if (!type) continue;
      const paths = pathsIn(file, /updateNumberOrInherit\('([^']+)'/g);
      expect(paths.length, file).toBeGreaterThan(0);
      for (const p of paths) expect(() => numberBoundsAt(boardSettingsSchemaFor(type), p), `${file}: ${p}`).not.toThrow();
    }
  });
});
