/**
 * Audit-19 0.1 / 0.2 — component-mount harness for the editor views.
 *
 * Mounts the REAL `TextTile.svelte` / `DocumentEditor.svelte` in jsdom (the
 * `component` vitest project resolves `svelte` with the `browser` condition so
 * client `mount()` works), wired to an in-memory `window.filo` that records every
 * write. This is the layer the body round-trip corpus can't see: what the
 * components do on mount, unmount, undo and reload.
 *
 * Mock envelope detail: `invokeOk` passes non-envelope payloads through, so the
 * read handler returns `{ ok: true, content, mtimeMs, size }` directly.
 */
import { mount, unmount, tick, flushSync } from 'svelte';
import type { Editor } from '@tiptap/core';
import TextTile from '@renderer/components/tiles/TextTile.svelte';
import DocumentEditor from '@renderer/components/boards/DocumentEditor.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import {
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../../helpers/filoBridge';
import { installEditorLoopBreaker, resetEditorLoopBreaker } from '../../helpers/editorLoopBreaker';
import type { TextTile as TextTileDef } from '@renderer/schema/index';

export const VAULT = '/vault';

// jsdom has no layout. ProseMirror's focus / scrollIntoView path asks for client
// rects; answer with empty geometry so editor commands run headless.
function emptyRects(): DOMRectList {
  const list = [] as unknown as DOMRectList & DOMRect[];
  (list as unknown as { item: (i: number) => DOMRect | null }).item = () => null;
  return list;
}
const zeroRect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
for (const proto of [Element.prototype, Range.prototype] as Array<{ getClientRects?: unknown; getBoundingClientRect?: unknown }>) {
  if (typeof proto.getClientRects !== 'function') proto.getClientRects = emptyRects;
  if (typeof proto.getBoundingClientRect !== 'function') proto.getBoundingClientRect = zeroRect;
}
if (typeof document.elementFromPoint !== 'function') {
  (document as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => null;
}

installEditorLoopBreaker();

export interface RecordedWrite {
  channel: string;
  relPath: string;
  content: string;
}

export interface RecordingFilo {
  files: Map<string, string>;
  writes: RecordedWrite[];
  calls: string[];
  writesTo(rel: string): RecordedWrite[];
  /** Replace a file's bytes as an EXTERNAL editor would (bumps mtime). */
  setExternal(rel: string, content: string): void;
  /** Make the next reads of `rel` reject with this error code. */
  failReads(rel: string, code: string | null): void;
  /** Make the next writes of `rel` fail with this error code. */
  failWrites(rel: string, code: string | null): void;
}

const WRITE_CHANNELS = new Set([
  'vault:write-file-text',
  'vault:write-existing-file-text',
  'vault:create-file-text',
]);

/**
 * In-memory `window.filo` built on the `installFiloMock` catch-all. Handles
 * `vault:read-file-text`, `vault:stat`, `vault:file-exists` and the markdown
 * write channels (which update the in-memory file and are recorded). `.filo/`
 * sentinel traffic is ignored by `writes`.
 */
export function recordingFilo(initial: Record<string, string>): RecordingFilo {
  const files = new Map<string, string>(Object.entries(initial));
  const mtimes = new Map<string, number>();
  let clock = 1000;
  for (const k of files.keys()) mtimes.set(k, clock);
  const readFailures = new Map<string, string>();
  const writeFailures = new Map<string, string>();
  const writes: RecordedWrite[] = [];
  const calls: string[] = [];

  const size = (s: string): number => new TextEncoder().encode(s).length;
  const fail = (code: string) => ({ ok: false, success: false, code, error: code });

  installFiloMock((channel: unknown, ...args: unknown[]) => {
    const ch = String(channel);
    calls.push(ch);
    const rel = typeof args[1] === 'string' ? (args[1] as string) : '';
    if (ch === 'vault:read-file-text') {
      const code = readFailures.get(rel);
      if (code) return fail(code);
      const content = files.get(rel);
      if (content === undefined) return fail('ENOENT');
      return { ok: true, success: true, content, mtimeMs: mtimes.get(rel) ?? clock, size: size(content) };
    }
    if (ch === 'vault:stat') {
      const content = files.get(rel);
      if (content === undefined) return fail('ENOENT');
      return { ok: true, success: true, mtimeMs: mtimes.get(rel) ?? clock, size: size(content) };
    }
    if (ch === 'vault:file-exists') return files.has(rel);
    if (WRITE_CHANNELS.has(ch)) {
      if (rel.startsWith('.filo/')) return { ok: true, success: true };
      const code = writeFailures.get(rel);
      if (code) return fail(code);
      if (ch === 'vault:create-file-text' && files.has(rel)) return fail('EEXIST');
      const content = String(args[2] ?? '');
      files.set(rel, content);
      clock += 10;
      mtimes.set(rel, clock);
      writes.push({ channel: ch, relPath: rel, content });
      return { ok: true, success: true, path: `${VAULT}/${rel}` };
    }
    return { ok: true, success: true };
  });

  return {
    files,
    writes,
    calls,
    writesTo: (r) => writes.filter((w) => w.relPath === r),
    setExternal: (r, content) => {
      files.set(r, content);
      clock += 10;
      mtimes.set(r, clock);
    },
    failReads: (r, code) => {
      if (code) readFailures.set(r, code);
      else readFailures.delete(r);
    },
    failWrites: (r, code) => {
      if (code) writeFailures.set(r, code);
      else writeFailures.delete(r);
    },
  };
}

/** Flush Svelte + microtasks + zero-delay timers (the hydrate chain). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Wait past the 300 ms markdown write debounce, then settle. */
export async function drainDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 360));
  await settle();
}

export function resetEditorHarness(): void {
  resetEditorLoopBreaker();
  cancelAllMarkdownWrites();
  __resetMarkdownFileWriterForTests();
  __resetDirtyTrackingForTests();
  __resetBaselinesForTests();
  documentStore.clear();
  tiptapToolbar.clearActiveEditor();
}

export function teardownEditorHarness(): void {
  resetEditorHarness();
  restoreFiloDefault();
  document.body.innerHTML = '';
}

export interface Mounted {
  target: HTMLElement;
  component: Record<string, unknown>;
  /** The live TipTap editor, found through the ProseMirror view on the DOM. */
  editor(): Editor;
  proseMirror(): HTMLElement;
  unmount(): Promise<void>;
}

function editorFrom(target: HTMLElement): Editor {
  const pm = target.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  if (!pm) throw new Error('no ProseMirror element mounted');
  // TipTap 3 attaches the editor instance to the view DOM.
  const ed = pm.editor;
  if (!ed) throw new Error('no editor instance on the ProseMirror element');
  return ed;
}

function wrap(target: HTMLElement, component: Record<string, unknown>): Mounted {
  let gone = false;
  return {
    target,
    component,
    editor: () => editorFrom(target),
    proseMirror: () => target.querySelector('.ProseMirror') as HTMLElement,
    unmount: async () => {
      if (gone) return;
      gone = true;
      await unmount(component);
      await settle();
    },
  };
}

export async function mountTextTile(opts: {
  tile: Partial<TextTileDef> & { id: string; contentId?: string };
}): Promise<Mounted> {
  vaultStore.setPath(VAULT);
  const tile = {
    type: 'text',
    title: 'Note',
    content: '',
    tags: [],
    ...opts.tile,
  } as unknown as TextTileDef;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(TextTile, {
    target,
    props: { tile },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  });
  await settle();
  return wrap(target, component as Record<string, unknown>);
}

/**
 * Mounts a DocumentEditor bound to a document tab. Seeds a placeholder
 * DocumentState (body `''`, the same shape `openTileAsDocument` creates) plus the
 * tab, then lets the editor's own disk hydrate run.
 */
export async function mountDocumentEditor(opts: {
  docId: string;
  docPath: string;
  title?: string;
}): Promise<Mounted> {
  vaultStore.setPath(VAULT);
  if (!documentStore.getDocument(opts.docId)) {
    documentStore.loadDocument({
      docId: opts.docId,
      filename: opts.docPath,
      title: opts.title ?? 'Doc',
      body: '',
      htmlContent: '',
      richText: [],
    });
  }
  tabStore.open(opts.docId, opts.title ?? 'Doc', 'document');
  const tab = tabStore.tabs.find((t) => t.boardId === opts.docId);
  if (!tab) throw new Error('tab not opened');
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(DocumentEditor, { target, props: { tabId: tab.id } });
  await settle();
  return wrap(target, component as Record<string, unknown>);
}

function pressKey(m: Mounted, key: string, extra: KeyboardEventInit = {}): void {
  const pm = m.proseMirror();
  pm.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
}

/** Ctrl+Z through the real ProseMirror keymap. */
export function pressUndo(m: Mounted): void {
  pressKey(m, 'z');
}

/** Ctrl+Y through the real ProseMirror keymap. */
export function pressRedo(m: Mounted): void {
  pressKey(m, 'y');
}

/** Capture console.error lines (e.g. Svelte's `effect_update_depth_exceeded`). */
export function captureConsoleErrors(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  };
  return { lines, restore: () => { console.error = orig; } };
}
