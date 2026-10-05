import { describe, it, expect, vi, afterEach } from 'vitest';
import { asTextMenuContext, NO_LINK, textMenuItems, type TextMenuParams } from '../../main/utils/textMenu';
import { createTextMenuQuery } from '../../main/services/textMenuQuery';

/**
 * The right-click menu on text (E-04): what main builds from Chromium's
 * context-menu params and the renderer's answer about links. Before, a menu
 * showed only on a misspelled word, with no Cut, Copy, Paste or Select All.
 */

function params(over: Partial<TextMenuParams> = {}): TextMenuParams {
  return {
    isEditable: true,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    ...over,
  };
}

const labels = (items: ReturnType<typeof textMenuItems>): string[] =>
  items.map((i) => {
    switch (i.kind) {
      case 'role': return `${i.role}${i.enabled ? '' : ' (off)'}`;
      case 'suggestion': return `suggest ${i.word}`;
      case 'add-word': return `add ${i.word}`;
      case 'link': return i.label;
      case 'separator': return '---';
    }
  });

describe('textMenuItems', () => {
  it('offers Cut, Copy, Paste and Select All on editable text, enabled as Chromium says', () => {
    expect(labels(textMenuItems(params(), NO_LINK))).toEqual([
      'cut (off)', 'copy (off)', 'paste', '---', 'selectAll',
    ]);
    const selected = params({ selectionText: 'word', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    expect(labels(textMenuItems(selected, NO_LINK))).toEqual(['cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('puts spelling first on a misspelled word: up to six suggestions, then Add to dictionary', () => {
    const items = textMenuItems(params({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech', 'ten', 'tea', 'tee', 'Te', 'tel'],
    }), NO_LINK);
    expect(labels(items)).toEqual([
      'suggest the', 'suggest tech', 'suggest ten', 'suggest tea', 'suggest tee', 'suggest Te', 'add teh',
      '---', 'cut (off)', 'copy (off)', 'paste', '---', 'selectAll',
    ]);
  });

  it('adds Insert Link in a note, and Edit Link on a link', () => {
    expect(labels(textMenuItems(params(), { link: 'insert' })).slice(-2)).toEqual(['---', 'Insert Link…']);
    expect(labels(textMenuItems(params(), { link: 'edit' })).slice(-2)).toEqual(['---', 'Edit Link…']);
  });

  it('offers Copy alone on selected text that cannot be edited, and nothing without a selection', () => {
    const page = params({ isEditable: false, selectionText: 'quoted', editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true } });
    expect(labels(textMenuItems(page, { link: 'insert' }))).toEqual(['copy']);
    expect(textMenuItems(params({ isEditable: false, selectionText: '   ' }), NO_LINK)).toEqual([]);
  });
});

describe('asTextMenuContext', () => {
  it('takes only the answers it knows', () => {
    expect(asTextMenuContext({ link: 'insert' })).toEqual({ link: 'insert' });
    expect(asTextMenuContext({ link: 'edit' })).toEqual({ link: 'edit' });
    for (const bad of [null, 'insert', { link: 'delete' }, { link: true }, []]) {
      expect(asTextMenuContext(bad)).toEqual(NO_LINK);
    }
  });
});

describe('createTextMenuQuery', () => {
  afterEach(() => vi.useRealTimers());

  function target(id = 7): { id: number; sent: number[]; send: (channel: 'app:text-menu-query', queryId: number) => void } {
    const sent: number[] = [];
    return { id, sent, send: (_channel, queryId) => { sent.push(queryId); } };
  }

  it('resolves with the renderer answer to its own question', async () => {
    const query = createTextMenuQuery(300);
    const page = target();
    const asked = query.ask(page);
    query.onReply(page.id, page.sent[0], { link: 'edit' });
    await expect(asked).resolves.toEqual({ link: 'edit' });
  });

  it('ignores an answer from another page, or to another question', async () => {
    vi.useFakeTimers();
    const query = createTextMenuQuery(300);
    const page = target(7);
    const asked = query.ask(page);
    query.onReply(8, page.sent[0], { link: 'insert' });
    query.onReply(7, (page.sent[0] ?? 0) + 1, { link: 'insert' });
    vi.advanceTimersByTime(300);
    await expect(asked).resolves.toEqual(NO_LINK);
  });

  it('opens without the link item when no answer comes in time, or the page is gone', async () => {
    vi.useFakeTimers();
    const query = createTextMenuQuery(300);
    const late = query.ask(target());
    vi.advanceTimersByTime(299);
    let settled = false;
    void late.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(late).resolves.toEqual(NO_LINK);

    const gone = query.ask({ id: 1, send: () => { throw new Error('destroyed'); } });
    await expect(gone).resolves.toEqual(NO_LINK);
  });
});
