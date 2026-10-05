/**
 * The right-click menu on text: what Chromium says about the spot clicked
 * (`context-menu` params), plus whether the renderer can add a link there,
 * become a list of items. Kept apart from Electron's `Menu` so it can be
 * tested; `main.ts` turns the items into menu entries.
 *
 * The renderer shows its own menus everywhere else (tiles, cards, the
 * canvas, tabs): a right-click reaches main only on editable text, or on
 * text selected in a page an embed shows.
 */

/** The parts of Electron's `ContextMenuParams` the menu reads. */
export interface TextMenuParams {
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/** What the renderer says about the focused editor. */
export interface TextMenuContext {
  /** 'insert' or 'edit' in a note's text (a link at the caret is edited); 'none' elsewhere. */
  link: 'insert' | 'edit' | 'none';
}

export type TextMenuItem =
  | { kind: 'suggestion'; word: string }
  | { kind: 'add-word'; word: string }
  | { kind: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; enabled: boolean }
  | { kind: 'link'; label: 'Insert Link…' | 'Edit Link…' }
  | { kind: 'separator' };

/** The most spelling suggestions shown. */
const MAX_SUGGESTIONS = 6;

/** No link for a context the renderer didn't answer for (an embed's page, a slow reply). */
export const NO_LINK: TextMenuContext = { link: 'none' };

/** A renderer reply, checked: anything unexpected means no link item. */
export function asTextMenuContext(value: unknown): TextMenuContext {
  if (!value || typeof value !== 'object') return NO_LINK;
  const link = (value as { link?: unknown }).link;
  return link === 'insert' || link === 'edit' ? { link } : NO_LINK;
}

/**
 * The menu's items, in groups: spelling, then Cut / Copy / Paste, then
 * Select All, then the link. Text that can't be edited offers Copy alone,
 * and only with something selected; an empty list shows no menu.
 */
export function textMenuItems(params: TextMenuParams, context: TextMenuContext): TextMenuItem[] {
  if (!params.isEditable) {
    return params.selectionText.trim() !== '' ? [{ kind: 'role', role: 'copy', enabled: params.editFlags.canCopy }] : [];
  }
  const groups: TextMenuItem[][] = [];
  if (params.misspelledWord) {
    groups.push([
      ...params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS).map((word): TextMenuItem => ({ kind: 'suggestion', word })),
      { kind: 'add-word', word: params.misspelledWord },
    ]);
  }
  groups.push([
    { kind: 'role', role: 'cut', enabled: params.editFlags.canCut },
    { kind: 'role', role: 'copy', enabled: params.editFlags.canCopy },
    { kind: 'role', role: 'paste', enabled: params.editFlags.canPaste },
  ]);
  groups.push([{ kind: 'role', role: 'selectAll', enabled: params.editFlags.canSelectAll }]);
  if (context.link !== 'none') {
    groups.push([{ kind: 'link', label: context.link === 'edit' ? 'Edit Link…' : 'Insert Link…' }]);
  }
  return groups.flatMap((group, i) => (i === 0 ? group : [{ kind: 'separator' } as const, ...group]));
}
