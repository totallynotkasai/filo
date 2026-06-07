/**
 * L2 (Audit-12) — TextTile's editor `onUpdate` used to write
 * `DocumentBoard.content` / `updatedAt` directly onto the by-reference
 * in-memory virtual `project.boards`, bypassing reactivity. The virtual
 * project is in-memory only and nothing reads `.content` as a write source
 * (the `.md` write sources from the editor markdown; `documentStore.updateContent`
 * is the canonical body sync the DocumentEditor's reactive `$effect` picks up),
 * so the mutation was vestigial. It was deleted.
 *
 * This is a source-scan pin (the mutation lived inside a tiptap `onUpdate`
 * handler in a Svelte component — mounting tiptap in jsdom isn't this suite's
 * convention; the repo pins component-internal invariants by source scan, e.g.
 * `characterization/externalEditReconciliation.test.ts`). It asserts the
 * vestigial `project.boards` write can't silently return AND that the canonical
 * `documentStore.updateContent` sync still runs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEXT_TILE_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'components',
  'tiles',
  'TextTile.svelte',
);

describe('TextTile — no in-memory project.boards mutation (Audit-12 L2)', () => {
  const rawSrc = fs.readFileSync(TEXT_TILE_PATH, 'utf8');
  // Blank comments before scanning so the explanatory comment that NAMES the
  // removed pattern (which legitimately mentions `project.boards` /
  // `getData()`) can't trip the scan — only live code is checked.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');

  it('does not iterate or write into the in-memory virtual project boards', () => {
    // The vestigial loop walked `project.boards` and assigned `.content`/`.updatedAt`.
    expect(src).not.toMatch(/project\.boards/);
    expect(src).not.toMatch(/\.getData\(\)/);
  });

  it('keeps the canonical documentStore.updateContent body sync', () => {
    expect(src).toMatch(/documentStore\.updateContent\(/);
  });
});
