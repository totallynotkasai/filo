import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import LazyTextTileBody from '@renderer/components/tiles/LazyTextTileBody.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { MOUNTS_PER_IDLE, pendingEditorMounts } from '@renderer/lib/editor/editorMountQueue';
import { uiStore } from '@renderer/stores/ui.svelte';
import { wantsNativeTextMenu } from '@renderer/lib/utils/editableTarget';
import type { Editor } from '@tiptap/core';
import type { TextTile } from '@renderer/schema/index';
import {
  VAULT,
  recordingFilo,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/** An IntersectionObserver the test drives: `fire` reports every observed card. */
class FakeIO {
  static all: FakeIO[] = [];
  targets: Element[] = [];
  constructor(
    readonly cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
    readonly opts: { rootMargin?: string } = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(t: Element): void { this.targets.push(t); }
  unobserve(): void {}
  disconnect(): void { this.targets = []; }
  takeRecords(): [] { return []; }
  fire(isIntersecting: boolean): void {
    if (this.targets.length) this.cb(this.targets.map((target) => ({ target, isIntersecting })));
  }
}
/** The "near the viewport" observers (the ones with a margin). */
const nearObservers = (): FakeIO[] => FakeIO.all.filter((o) => o.opts.rootMargin);

const NOTE = '---\ntitle: Card\n---\n\nHello **world**\n\n- [ ] a task\n';

function tile(id: string, filePath: string): TextTile {
  return { id, type: 'text', title: '', content: '', tags: [], filePath } as unknown as TextTile;
}

const mounted: Array<Record<string, unknown>> = [];
function mountBody(t: TextTile): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LazyTextTileBody, {
    target,
    props: { tile: t },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  }) as Record<string, unknown>);
  flushSync();
  return target;
}

const editorOf = (el: HTMLElement): Editor =>
  (el.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;

const origIO = globalThis.IntersectionObserver;

describe('LazyTextTileBody: a card shows a preview until its editor is needed', () => {
  beforeEach(() => {
    resetEditorHarness();
    FakeIO.all = [];
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    vaultStore.setPath(VAULT);
  });
  afterEach(async () => {
    for (const c of mounted.splice(0)) await unmount(c);
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = origIO;
    vaultIndexStore.clear();
    teardownEditorHarness();
  });

  it('off screen: shows the note as HTML, builds no editor, reads no file', async () => {
    const fs = recordingFilo({ 'Card.md': NOTE });
    vaultIndexStore.restoreMetadata('Card.md', parseMarkdown('Card.md', NOTE));
    const el = mountBody(tile('t1', 'Card.md'));
    await settle();
    const preview = el.querySelector('[data-note-preview]');
    expect(preview?.querySelector('strong')?.textContent).toBe('world');
    expect(preview?.querySelector('ul[data-type="taskList"]')).not.toBeNull();
    expect(el.querySelector('.ProseMirror')).toBeNull();
    expect(noteStore.get('Card.md')).toBeUndefined();
    expect(fs.calls.filter((c) => c === 'vault:read-file-text')).toEqual([]);
  });

  it('a press on the preview mounts the editor at once, and typing saves to the note', async () => {
    const fs = recordingFilo({ 'Card.md': NOTE });
    vaultIndexStore.restoreMetadata('Card.md', parseMarkdown('Card.md', NOTE));
    const el = mountBody(tile('t1', 'Card.md'));
    const text = el.querySelector('.lazy-preview-text') as HTMLElement;
    text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    expect(el.querySelector('.ProseMirror')).not.toBeNull();
    expect(el.querySelector('[data-note-preview]')).toBeNull();
    await settle();
    expect(editorOf(el).getText()).toContain('Hello world');
    const ed = editorOf(el);
    ed.commands.focus('end');
    ed.commands.insertContent(' typed');
    await drainDebounce();
    const writes = fs.writesTo('Card.md');
    expect(writes.length).toBe(1);
    expect(writes[0]?.content).toContain('typed');
    expect(writes[0]?.content).toContain('title: Card');
  });

  it('keyboard focus on the preview mounts the editor', async () => {
    recordingFilo({ 'Card.md': NOTE });
    const el = mountBody(tile('t1', 'Card.md'));
    (el.querySelector('[data-note-preview]') as HTMLElement).dispatchEvent(new FocusEvent('focus'));
    expect(el.querySelector('.ProseMirror')).not.toBeNull();
    await settle();
  });

  it('near the viewport: editors mount in batches of at most MOUNTS_PER_IDLE', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`N${i}.md`] = `note ${i}\n`;
    recordingFilo(files);
    const els = Object.keys(files).map((p, i) => mountBody(tile(`t${i}`, p)));
    const editors = (): number => els.filter((e) => e.querySelector('.ProseMirror')).length;
    expect(editors()).toBe(0);
    for (const o of nearObservers()) o.fire(true);
    expect(pendingEditorMounts()).toBe(12);
    // One idle batch (jsdom has no requestIdleCallback: a 16 ms timer stands in).
    await new Promise((r) => setTimeout(r, 20));
    expect(editors()).toBeGreaterThan(0);
    expect(editors()).toBeLessThanOrEqual(MOUNTS_PER_IDLE);
    await settle(40);
    await new Promise((r) => setTimeout(r, 120));
    expect(editors()).toBe(12);
  });

  it('a card unmounted before its turn leaves nothing queued', async () => {
    recordingFilo({ 'Card.md': NOTE });
    mountBody(tile('t1', 'Card.md'));
    for (const o of nearObservers()) o.fire(true);
    expect(pendingEditorMounts()).toBe(1);
    for (const c of mounted.splice(0)) await unmount(c);
    expect(pendingEditorMounts()).toBe(0);
  });

  it('a right-click on the preview neither focuses it nor mounts the editor', async () => {
    recordingFilo({ 'Card.md': NOTE });
    const el = mountBody(tile('t1', 'Card.md'));
    const text = el.querySelector('.lazy-preview-text') as HTMLElement;
    text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    text.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(el.querySelector('.ProseMirror')).toBeNull();
  });

  it('an editor that loads while a menu is open leaves the focus with the menu', async () => {
    recordingFilo({ 'Card.md': NOTE });
    const el = mountBody(tile('t1', 'Card.md'));
    (el.querySelector('[data-note-preview]') as HTMLElement).dispatchEvent(new FocusEvent('focus'));
    uiStore.showContextMenu(10, 10, [{ id: 'x', label: 'Open', action: () => {} }]);
    await settle(40);
    expect(editorOf(el).isFocused).toBe(false);
    uiStore.hideContextMenu();
  });

  it('a loaded card: its text shows the card menu, and the text menu only while it is being edited', async () => {
    recordingFilo({ 'Card.md': NOTE });
    const el = mountBody(tile('t1', 'Card.md'));
    (el.querySelector('.lazy-preview-text') as HTMLElement)
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    await settle(40);
    const pm = el.querySelector('.ProseMirror') as HTMLElement;
    const menuOn = (): boolean => {
      const e = new MouseEvent('contextmenu', { bubbles: true });
      Object.defineProperty(e, 'target', { value: pm });
      return wantsNativeTextMenu(e);
    };
    editorOf(el).commands.focus('end');
    expect(menuOn()).toBe(true);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    pm.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);

    pm.blur();
    expect(menuOn()).toBe(false);
    const downUnfocused = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    pm.dispatchEvent(downUnfocused);
    expect(downUnfocused.defaultPrevented).toBe(true);
  });
});
