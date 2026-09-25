import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installLinkClickHandling, LINK_OPEN_HINT } from '@renderer/lib/editor/linkClicks';
import {
  recordingFilo,
  mountTextTile,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
  type Mounted,
  type RecordingFilo,
} from './helpers/mountEditor';

/**
 * A plain click on a link inside a note being edited places the caret, so the
 * link's text can be edited; Ctrl+click opens it. Anywhere else a plain click
 * opens it. Before, every click opened the link, so the caret could never be
 * put inside one.
 */
describe('clicking a link in an editor', () => {
  let uninstall: (() => void) | null = null;
  let fs: RecordingFilo;
  let m: Mounted;

  beforeEach(async () => {
    resetEditorHarness();
    fs = recordingFilo({ 'Note.md': 'See [site](https://example.com) now\n' });
    uninstall = installLinkClickHandling();
    m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
  });
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    teardownEditorHarness();
  });

  function anchor(): HTMLAnchorElement {
    const a = m.proseMirror().querySelector('a');
    if (!a) throw new Error('no link rendered');
    return a;
  }

  /** pointerdown then click, as a real click delivers them. */
  function clickLink(init: MouseEventInit = {}): MouseEvent {
    const a = anchor();
    a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...init }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    a.dispatchEvent(click);
    return click;
  }

  const opens = (): number => fs.calls.filter((c) => c === 'media:open-external').length;

  it('a plain click in a tile that is not being edited opens the link', () => {
    expect(m.proseMirror().contains(document.activeElement)).toBe(false);
    clickLink();
    expect(opens()).toBe(1);
  });

  it('a plain click in the note being edited does not open the link', async () => {
    m.editor().commands.focus();
    await settle();
    const click = clickLink();
    expect(opens()).toBe(0);
    // No navigation either.
    expect(click.defaultPrevented).toBe(true);
  });

  it('Ctrl+click in the note being edited opens the link', async () => {
    m.editor().commands.focus();
    await settle();
    clickLink({ ctrlKey: true });
    expect(opens()).toBe(1);
  });

  it('Cmd+click opens it too', async () => {
    m.editor().commands.focus();
    await settle();
    clickLink({ metaKey: true });
    expect(opens()).toBe(1);
  });

  it('a plain click in a read-only editor opens the link, focused or not', async () => {
    m.editor().setEditable(false, false);
    m.editor().commands.focus();
    await settle();
    clickLink();
    expect(opens()).toBe(1);
  });

  it('hovering a link shows its URL and the Ctrl+click hint, outside the editor DOM', () => {
    const host = m.proseMirror().parentElement!;
    anchor().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(host.getAttribute('title')).toBe(`https://example.com\n${LINK_OPEN_HINT}`);
    expect(anchor().hasAttribute('title')).toBe(false);
    m.proseMirror().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(host.hasAttribute('title')).toBe(false);
  });
});
