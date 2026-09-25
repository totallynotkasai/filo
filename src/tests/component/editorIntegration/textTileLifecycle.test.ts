/**
 * Audit-19 0.2 — editor-level integration suite: the REAL `TextTile.svelte`
 * mounted in jsdom with real TipTap, driven through mount / unmount / undo /
 * reload. The body round-trip corpus drives the editor factory WITHOUT the
 * components, so it can't see what they do on mount, unmount, undo or reload —
 * the layer where MD-1 / MD-2 / MD-3 lived. Pinned by ci:markdown-body-roundtrip
 * (EDITOR_SUITE arm).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import TextTile from '@renderer/components/tiles/TextTile.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { editorMarkdown, parseMarkdownFile } from '@renderer/lib/editor/markdownSync';
import type { TextTile as TextTileDef } from '@renderer/schema/index';
import {
  recordingFilo,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
  VAULT,
} from '../helpers/mountEditor';
import type { Editor } from '@tiptap/core';

const CORPUS_DIR = join(process.cwd(), 'src/tests/unit/fixtures/markdown-body-roundtrip');
const corpus = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.md') && !f.includes('.expected'))
  .sort()
  .map((f) => ({ name: f.slice(0, -3), raw: readFileSync(join(CORPUS_DIR, f), 'utf8') }));
const toCrlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

/** The tile's note is `<title>.md`; that path is also its document key. */
async function mountTile(title = 'Note') {
  vaultStore.setPath(VAULT);
  const filePath = `${title}.md`;
  const tile = { id: 't1', type: 'text', title, filePath, content: '', tags: [] } as unknown as TextTileDef;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(TextTile, {
    target,
    props: { tile },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  });
  await settle();
  const pm = target.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
  return { target, component, pm, editor: pm.editor, notePath: filePath };
}

function ctrlZ(pm: HTMLElement): void {
  pm.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
}

describe('TextTile lifecycle (editor integration)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  describe('(a) mount → unmount without an edit writes nothing — every corpus fixture', () => {
    for (const fx of corpus) {
      for (const [label, raw] of [['LF', fx.raw], ['CRLF', toCrlf(fx.raw)]] as const) {
        it(`${fx.name} (${label})`, async () => {
          const fs = recordingFilo({ 'Note.md': raw });
          const t = await mountTile();
          await unmount(t.component);
          await drainDebounce();
          expect(fs.writesTo('Note.md')).toEqual([]);
          expect(fs.files.get('Note.md')).toBe(raw);
        });
      }
    }
  });

  it('(b) load → Ctrl+Z leaves body and disk unchanged', async () => {
    const fs = recordingFilo({ 'Note.md': 'Precious text\n' });
    const t = await mountTile();
    ctrlZ(t.pm);
    await drainDebounce();
    expect(editorMarkdown(t.editor)).toContain('Precious text');
    expect(fs.writesTo('Note.md')).toEqual([]);
    await unmount(t.component);
  });

  it('(c) reload → Ctrl+Z does not resurrect the pre-reload text and does not write', async () => {
    const fs = recordingFilo({ 'Note.md': 'Before reload\n' });
    const t = await mountTile();
    fs.setExternal('Note.md', 'After reload\n');
    await noteStore.onDiskChanged(t.notePath);
    await settle();
    expect(t.pm.textContent).toContain('After reload');
    ctrlZ(t.pm);
    await drainDebounce();
    expect(t.pm.textContent).toContain('After reload');
    expect(t.pm.textContent).not.toContain('Before reload');
    expect(fs.writesTo('Note.md')).toEqual([]);
    await unmount(t.component);
  });

  it('(d) a body opening with a `---` rule pair survives mount → edit → write', async () => {
    const fs = recordingFilo({ 'Note.md': '---\ntitle: x\n---\n---\n\nSome intro\n\n---\n\nMore text\n' });
    const t = await mountTile();
    t.editor.commands.focus('end');
    t.editor.commands.insertContent('!');
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBe(1);
    expect(parseMarkdownFile(writes[0].content).body).toContain('Some intro');
    await unmount(t.component);
  });

  it('(e) a one-char edit writes once, with only that delta', async () => {
    const fs = recordingFilo({ 'Note.md': 'Hello world' });
    const t = await mountTile();
    t.editor.commands.focus('end');
    t.editor.commands.insertContent('!');
    await drainDebounce();
    await unmount(t.component);
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBe(1);
    expect(writes[0].content).toBe('Hello world!');
  });

  it('(f) an edit to a BOM + CRLF note keeps the BOM and CRLF throughout', async () => {
    const raw = '﻿---\r\ntitle: x\r\n---\r\nFirst line\r\n\r\nSecond line\r\n';
    const fs = recordingFilo({ 'Note.md': raw });
    const t = await mountTile();
    t.editor.commands.focus('end');
    t.editor.commands.insertContent('!');
    await drainDebounce();
    await unmount(t.component);
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBe(1);
    const out = writes[0].content;
    expect(out.startsWith('﻿---\r\ntitle: x\r\n---\r\n')).toBe(true);
    expect(out).toContain('Second line!');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
