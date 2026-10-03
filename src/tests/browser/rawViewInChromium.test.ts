import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import type { EditorView } from '@codemirror/view';
import '../../css/style.css';
import NoteRawView from '../../renderer/components/boards/NoteRawView.svelte';
import { vaultStore } from '../../renderer/stores/vault.svelte';
import { _resetForTests as resetShortcuts, initKeyboardShortcuts, registerShortcut } from '../../renderer/core/hotkeys';
import {
  recordingFilo,
  mountDocumentEditor,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
  VAULT,
  type RecordingFilo,
} from '../component/helpers/mountEditor';
import { loadedRawView, selectedText } from '../component/helpers/rawView';

/**
 * The Raw view's text field (CodeMirror) in real Chromium, with real key
 * presses and the app's stylesheet: typing, its own undo, Ctrl+S, Tab leaving
 * the field, its find bar, the box it draws, "Edit in Raw view" scrolling the
 * named line into view, and the app's editor shortcuts kept out of it.
 */

const NOTE = '---\ntitle: Plan\ntags: [work]\n---\n# Heading\n\nSome **bold** text and a [link](https://example.test).\n';

let mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetEditorHarness();
  resetShortcuts();
  // The theme tokens are defined per theme, as the app sets one on <html>.
  document.documentElement.dataset.theme = 'light';
});

afterEach(async () => {
  for (const m of mounted) await unmount(m);
  mounted = [];
  await settle();
  teardownEditorHarness();
});

/** The Raw view of `path`, mounted 720 px wide as in a Document tab. */
async function rawViewOf(files: Record<string, string>, path: string): Promise<{ filo: RecordingFilo; view: EditorView; target: HTMLElement }> {
  const filo = recordingFilo(files);
  vaultStore.setPath(VAULT);
  const target = document.createElement('div');
  target.style.width = '720px';
  document.body.appendChild(target);
  mounted.push(mount(NoteRawView, { target, props: { path } }));
  const view = await loadedRawView(target);
  return { filo, view, target };
}

/** Puts the caret at the end of the text, by a real key. */
async function caretToEnd(view: EditorView): Promise<void> {
  await userEvent.click(view.contentDOM);
  await userEvent.keyboard('{Control>}{End}{/Control}');
  await expect.poll(() => view.state.selection.main.head).toBe(view.state.doc.length);
}

describe('typing and saving', () => {
  it('typed keys land in the text; Ctrl+Z takes them back', async () => {
    const { view } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    await caretToEnd(view);
    await userEvent.keyboard('More');
    await expect.poll(() => view.state.doc.toString()).toBe(`${NOTE}More`);
    await userEvent.keyboard('{Control>}z{/Control}');
    await expect.poll(() => view.state.doc.toString()).toBe(NOTE);
  });

  it('Ctrl+S saves what is typed, and the field keeps the focus', async () => {
    const { filo, view, target } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    await caretToEnd(view);
    await userEvent.keyboard('Saved line');
    await expect.poll(() => target.querySelector('.raw-status')?.textContent ?? '').toContain('Unsaved changes');
    await userEvent.keyboard('{Control>}s{/Control}');
    await expect.poll(() => filo.files.get('Plan.md')).toBe(`${NOTE}Saved line`);
    expect(view.hasFocus).toBe(true);
    await expect.poll(() => (target.querySelector('.raw-status')?.textContent ?? '').trim()).toBe('');
  });

  it('Tab leaves the field (no tab typed), and leaving saves', async () => {
    const { filo, view } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    const after = document.createElement('button');
    after.textContent = 'Next control';
    document.body.appendChild(after);
    await caretToEnd(view);
    await userEvent.keyboard('Typed');
    await userEvent.keyboard('{Tab}');
    await expect.poll(() => view.hasFocus).toBe(false);
    expect(view.state.doc.toString()).toBe(`${NOTE}Typed`);
    await expect.poll(() => filo.files.get('Plan.md')).toBe(`${NOTE}Typed`);
  });
});

describe('a file dropped on the field', () => {
  it('is not read into the text (CodeMirror would insert a text file)', async () => {
    const { view, filo } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    const at = view.contentDOM.getBoundingClientRect();
    const data = new DataTransfer();
    data.items.add(new File(['Dropped words\n'], 'dropped.txt', { type: 'text/plain' }));
    const drop = new DragEvent('drop', {
      dataTransfer: data,
      clientX: at.left + 40,
      clientY: at.top + 10,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(drop);
    // CodeMirror reads a dropped file before inserting it: give the read time.
    await new Promise((r) => setTimeout(r, 300));
    expect(view.state.doc.toString()).toBe(NOTE);
    expect(drop.defaultPrevented).toBe(true);
    expect(filo.writes).toHaveLength(0);
  });
});

describe('the find bar', () => {
  it('Ctrl+F opens it with the focus in it; finding marks the match; moving there does not save', async () => {
    const { filo, view, target } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    await caretToEnd(view);
    await userEvent.keyboard('x');
    const writesBefore = filo.writes.length;
    await userEvent.keyboard('{Control>}f{/Control}');
    const find = (): HTMLInputElement | null => target.querySelector('.cm-search input[name="search"]');
    await expect.poll(() => document.activeElement === find()).toBe(true);
    await userEvent.keyboard('bold');
    await expect.poll(() => target.querySelectorAll('.cm-searchMatch').length).toBe(1);
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => selectedText(view)).toBe('bold');
    // Still inside the Raw view: nothing saved yet.
    expect(filo.writes.length).toBe(writesBefore);
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => find()).toBe(null);
    await expect.poll(() => view.hasFocus).toBe(true);
  });
});

describe('the box', () => {
  it("keeps the textarea's box: 480 px, resizable, mono, scrolling inside", async () => {
    const long = `${NOTE}${Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n')}\n`;
    const { view } = await rawViewOf({ 'Long.md': long }, 'Long.md');
    const box = getComputedStyle(view.dom);
    expect(view.dom.getBoundingClientRect().height).toBe(480);
    expect(box.resize).toBe('vertical');
    const scroller = getComputedStyle(view.scrollDOM);
    expect(scroller.fontSize).toBe('13px');
    expect(scroller.fontFamily.toLowerCase()).toMatch(/mono|consolas|courier/);
    // Every character drawn as written: no `-->` drawn as an arrow.
    expect(scroller.fontVariantLigatures).toBe('none');
    expect(view.scrollDOM.scrollHeight).toBeGreaterThan(view.scrollDOM.clientHeight);
    // Line numbers.
    expect(view.dom.querySelector('.cm-lineNumbers')?.textContent).toContain('12');
  });

  it('colours the Markdown: markup muted, heading bold, link underlined, frontmatter keys stronger', async () => {
    const { view } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    /**
     * The first `.cls` element (showing `text`, when given) outside the
     * frontmatter, or in it for a `cm-filo-` class.
     */
    const span = (cls: string, text?: string): HTMLElement => {
      const el = [...view.contentDOM.querySelectorAll<HTMLElement>(`.${cls}`)].find(
        (e) =>
          (cls.startsWith('cm-filo-') || e.closest('.cm-filo-fm') === null) &&
          (text === undefined || e.textContent === text),
      );
      if (!el) throw new Error(`no .${cls}`);
      return el;
    };
    const colourOf = (token: string): string => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    // Tertiary and primary differ, so the checks below tell them apart.
    expect(colourOf('--text-tertiary')).not.toBe(colourOf('--text-primary'));
    expect(getComputedStyle(span('tok-heading')).fontWeight).toBe('700');
    expect(getComputedStyle(span('tok-meta')).color).toBe(colourOf('--text-tertiary'));
    // The link's words are underlined; its brackets and address are markup.
    expect(getComputedStyle(span('tok-link', 'link')).textDecorationLine).toBe('underline');
    expect(getComputedStyle(span('tok-link', 'link')).color).toBe(colourOf('--text-primary'));
    expect(getComputedStyle(span('tok-link', '[')).textDecorationLine).toBe('none');
    expect(getComputedStyle(span('tok-url')).color).toBe(colourOf('--text-tertiary'));
    expect(getComputedStyle(span('cm-filo-fm-key')).fontWeight).toBe('600');
    expect(getComputedStyle(span('cm-filo-fm-key')).color).toBe(colourOf('--text-primary'));
    expect(getComputedStyle(span('cm-filo-fm-fence')).color).toBe(colourOf('--text-tertiary'));
    // Markdown reads `tags: [work]` + `---` as a heading holding a link; in the
    // frontmatter it shows as a key and a plain, muted value.
    const value = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-filo-fm .tok-link')].find(
      (e) => e.textContent === 'work',
    );
    expect(value).toBeTruthy();
    expect(getComputedStyle(value!).fontWeight).toBe('400');
    expect(getComputedStyle(value!).textDecorationLine).toBe('none');
    expect(getComputedStyle(value!).color).toBe(colourOf('--text-secondary'));
    expect(getComputedStyle(span('cm-filo-fm-fence')).fontWeight).toBe('400');
  });
});

describe('Edit in Raw view', () => {
  it('scrolls the named line about a third of the way down, selected and marked', async () => {
    // Text on both sides, so the box can scroll the line to a third of the way down.
    const filler = (from: number): string => Array.from({ length: 120 }, (_, i) => `Paragraph ${from + i}.\n`).join('\n');
    const note = `---\ntitle: Wrapped\n---\n${filler(1)}\nA paragraph with a <!-- a comment --> comment.\n\n${filler(121)}`;
    recordingFilo({ 'Wrapped.md': note });
    const m = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    mounted.push(m.component as Record<string, unknown>);
    const button = [...m.target.querySelectorAll<HTMLButtonElement>('.readonly-banner .readonly-action')].find(
      (b) => b.textContent?.trim() === 'Edit in Raw view',
    );
    expect(button).toBeTruthy();
    await userEvent.click(button!);
    const view = await loadedRawView(m.target);
    await expect.poll(() => selectedText(view)).toBe('A paragraph with a <!-- a comment --> comment.');
    expect(view.hasFocus).toBe(true);
    // The line is drawn, inside the box, near a third of the way down.
    await expect.poll(() => view.dom.querySelector('.cm-filo-named-line') !== null).toBe(true);
    const line = view.dom.querySelector('.cm-filo-named-line')!.getBoundingClientRect();
    const box = view.scrollDOM.getBoundingClientRect();
    expect(line.top).toBeGreaterThanOrEqual(box.top);
    expect(line.bottom).toBeLessThanOrEqual(box.bottom);
    const third = (line.top - box.top) / box.height;
    expect(third).toBeGreaterThan(0.2);
    expect(third).toBeLessThan(0.45);
  });
});

describe('app shortcuts', () => {
  it('Ctrl+K, Ctrl+Shift+F and Ctrl+O do nothing in the Raw view; outside it they still fire', async () => {
    initKeyboardShortcuts();
    const fired: string[] = [];
    for (const [id, key, shift] of [
      ['editor:insert-link', 'k', false],
      ['search:open', 'f', true],
      ['vault:open', 'o', false],
    ] as const) {
      registerShortcut({ commandId: id, key, ctrl: true, shift, description: id, allowInEditor: true, action: () => fired.push(id) });
    }
    const { view } = await rawViewOf({ 'Plan.md': NOTE }, 'Plan.md');
    await caretToEnd(view);
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}');
    await userEvent.keyboard('{Control>}o{/Control}');
    expect(fired).toEqual([]);
    expect(view.state.doc.toString()).toBe(NOTE);
    // The same keys elsewhere reach the app.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(fired).toEqual(['editor:insert-link']);
  });
});
