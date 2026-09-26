/**
 * Toolbar store — tracks active text formatting state
 * and undo/redo availability for the GlobalToolbar.
 */

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
let heading = $state<'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>('normal');
let spellcheck = $state(true);
/**
 * The note the focused editor shows, or null for a label or a title. The
 * toolbar reads the note's line spacing from it, so an undo shows at once.
 */
let lineSpacingNote = $state<string | null>(null);

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
  get heading() { return heading; },
  get spellcheck() { return spellcheck; },
  get lineSpacingNote() { return lineSpacingNote; },
  get lineSpacingAvailable() { return lineSpacingNote !== null; },

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
    heading?: 'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    lineSpacingNote?: string | null;
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
    if (state.heading !== undefined) heading = state.heading;
    if (state.lineSpacingNote !== undefined) lineSpacingNote = state.lineSpacingNote;
  },

  toggleSpellcheck() {
    spellcheck = !spellcheck;
    // Apply to all Tiptap editor elements
    document.querySelectorAll('.tiptap').forEach((el) => {
      (el as HTMLElement).setAttribute('spellcheck', String(spellcheck));
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
    heading = 'normal';
    lineSpacingNote = null;
  },
};
