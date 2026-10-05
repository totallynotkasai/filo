/**
 * Toolbar store — tracks active text formatting state
 * and undo/redo availability for the GlobalToolbar.
 */

import { workspaceStore } from './workspace.svelte';

let bold = $state(false);
let italic = $state(false);
let underline = $state(false);
/** The caret or selection is inside a link. */
let link = $state(false);
let textColor = $state('#ffffff');
let highlightColor = $state('transparent');
/**
 * The selection's own font mark, or '' when it has none: its text is then in
 * the global font, which the toolbar shows instead.
 */
let fontFamily = $state('');
let fontSize = $state(14);
let textAlign = $state<'left' | 'center' | 'right' | 'justify'>('left');
/** The focused text can be aligned (not in a list, code or a connection label). */
let alignAvailable = $state(true);
/** Align is off because the caret is in a list item, which the control says. */
let alignInList = $state(false);
/** The focused editor holds lists (a title or a connection label doesn't). */
let listsAvailable = $state(true);
let heading = $state<'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>('normal');
/**
 * The note the focused editor shows, or null for a label or a title. The
 * toolbar reads the note's line spacing from it, so an undo shows at once.
 */
let lineSpacingNote = $state<string | null>(null);
/**
 * The focused editor's own undo history, or null with no editor focused. The
 * toolbar's Undo / Redo act on it then, as Ctrl+Z does.
 */
let editorHistory = $state<{ canUndo: boolean; canRedo: boolean } | null>(null);

export const toolbarStore = {
  get bold() { return bold; },
  get italic() { return italic; },
  get underline() { return underline; },
  get link() { return link; },
  get textColor() { return textColor; },
  get highlightColor() { return highlightColor; },
  get fontFamily() { return fontFamily; },
  get fontSize() { return fontSize; },
  get textAlign() { return textAlign; },
  get alignAvailable() { return alignAvailable; },
  get alignInList() { return alignInList; },
  get listsAvailable() { return listsAvailable; },
  get heading() { return heading; },
  /** Spell check, kept with the vault's layout (`.filo/workspace.json`) and read by every editor made after a change. */
  get spellcheck() { return workspaceStore.spellcheck; },
  get lineSpacingNote() { return lineSpacingNote; },
  get lineSpacingAvailable() { return lineSpacingNote !== null; },
  get editorHistory() { return editorHistory; },

  /**
   * Updates all formatting state at once (called by the active Tiptap editor).
   */
  updateFromEditor(state: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    link?: boolean;
    textColor?: string;
    highlightColor?: string;
    fontFamily?: string;
    fontSize?: number;
    textAlign?: 'left' | 'center' | 'right' | 'justify';
    alignAvailable?: boolean;
    alignInList?: boolean;
    listsAvailable?: boolean;
    heading?: 'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    lineSpacingNote?: string | null;
    editorHistory?: { canUndo: boolean; canRedo: boolean } | null;
  }) {
    if (state.bold !== undefined) bold = state.bold;
    if (state.italic !== undefined) italic = state.italic;
    if (state.underline !== undefined) underline = state.underline;
    if (state.link !== undefined) link = state.link;
    if (state.textColor !== undefined) textColor = state.textColor;
    if (state.highlightColor !== undefined) highlightColor = state.highlightColor;
    if (state.fontFamily !== undefined) fontFamily = state.fontFamily;
    if (state.fontSize !== undefined) fontSize = state.fontSize;
    if (state.textAlign !== undefined) textAlign = state.textAlign;
    if (state.alignAvailable !== undefined) alignAvailable = state.alignAvailable;
    if (state.alignInList !== undefined) alignInList = state.alignInList;
    if (state.listsAvailable !== undefined) listsAvailable = state.listsAvailable;
    if (state.heading !== undefined) heading = state.heading;
    if (state.lineSpacingNote !== undefined) lineSpacingNote = state.lineSpacingNote;
    if (state.editorHistory !== undefined) editorHistory = state.editorHistory;
  },

  toggleSpellcheck() {
    const on = !workspaceStore.spellcheck;
    workspaceStore.setSpellcheck(on);
    // The editors already open show it at once; each reads the setting again on its next update.
    document.querySelectorAll('.tiptap').forEach((el) => {
      (el as HTMLElement).setAttribute('spellcheck', String(on));
    });
  },

  /**
   * Resets toolbar state to defaults (when no editor is focused).
   */
  reset() {
    bold = false;
    italic = false;
    underline = false;
    link = false;
    textColor = '#ffffff';
    highlightColor = 'transparent';
    fontFamily = '';
    fontSize = 14;
    textAlign = 'left';
    alignAvailable = true;
    alignInList = false;
    listsAvailable = true;
    heading = 'normal';
    lineSpacingNote = null;
    editorHistory = null;
  },
};
