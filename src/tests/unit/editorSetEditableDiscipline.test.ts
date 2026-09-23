import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { setEditorEditable } from '../../renderer/lib/editor/setEditorEditable';

/**
 * DEPENDENCY_UPGRADE_REPORT_2026-09-23 §0.2 — the Document editor's close-drain
 * `$effect` called TipTap's `editor.setEditable(x)`, whose default
 * `emitUpdate = true` fired `onUpdate` → `documentStore.updateContent` inside
 * the effect: an `effect_update_depth_exceeded` loop that svelte 5.57.1 turned
 * into a phantom write (a CRLF note flipped to LF just by opening it).
 *
 * 1. `setEditorEditable` toggles editability on a REAL editor without emitting
 *    `update` (so no onUpdate → no store write → no debounced disk write).
 * 2. No renderer file calls `.setEditable(` directly — every toggle goes
 *    through the helper. (The real-app guard is `e2e/documentOpenNoWrite`.)
 */

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('setEditorEditable', () => {
  it('toggles editability without emitting an update', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let updates = 0;
    editor = createTiptapEditor({ element: el, content: '', onUpdate: () => { updates++; } });
    loadMarkdownIntoEditor(editor, '# Hello\r\n\r\nSome **bold** text.\r\n');
    updates = 0;

    setEditorEditable(editor, false);
    expect(editor.isEditable).toBe(false);
    setEditorEditable(editor, true);
    expect(editor.isEditable).toBe(true);
    setEditorEditable(editor, true); // no-op when unchanged
    expect(updates).toBe(0);
  });

  it('is a no-op on a null or destroyed editor', () => {
    expect(() => setEditorEditable(null, false)).not.toThrow();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ed = createTiptapEditor({ element: el, content: '' });
    ed.destroy();
    expect(() => setEditorEditable(ed, false)).not.toThrow();
  });
});

describe('no raw editor.setEditable( outside the helper', () => {
  const RENDERER = resolve(__dirname, '../../renderer');
  const HELPER = join(RENDERER, 'lib', 'editor', 'setEditorEditable.ts');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|svelte)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('routes every editability toggle through setEditorEditable', () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER)) {
      if (file === HELPER) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/\.setEditable\s*\(/.test(code)) offenders.push(relative(RENDERER, file));
    }
    expect(offenders).toEqual([]);
  });
});
