/**
 * Contract — "is focus in a text editor?" is asked one way.
 *
 * Chromium implements `HTMLElement.isContentEditable`; jsdom, which the
 * unit, component and characterisation suites run in, doesn't (it reads
 * `undefined`). A check that reads the property directly therefore sees a
 * TipTap editor as not being one in every test, and a test going through it
 * can pass or fail where the app wouldn't (a key typed into a new tile's
 * title reached the Mind Map's N that way). `isContentEditableAware`
 * (`lib/utils/editableTarget.ts`) agrees with Chromium and works in jsdom,
 * so renderer code asks through it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isContentEditableAware } from '@renderer/lib/utils/editableTarget';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const HELPER = path.join(RENDERER, 'lib', 'utils', 'editableTarget.ts');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('content-editable checks', () => {
  it('no renderer code reads isContentEditable except the helper', () => {
    const offenders: string[] = [];
    for (const file of sources(RENDERER)) {
      if (file === HELPER) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/\.isContentEditable\b/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the helper sees a node inside a TipTap-style editor as editable, and a contenteditable="false" island as not', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('p');
    editor.appendChild(line);
    document.body.appendChild(editor);
    try {
      expect(isContentEditableAware(line)).toBe(true);
      const off = document.createElement('span');
      off.setAttribute('contenteditable', 'false');
      line.appendChild(off);
      expect(isContentEditableAware(off)).toBe(false);
    } finally {
      editor.remove();
    }
  });
});
