/**
 * Toolbar store — tracks active text formatting state
 * and undo/redo availability for the GlobalToolbar.
 */

let bold = $state(false);
let italic = $state(false);
let underline = $state(false);
let textColor = $state('#ffffff');
let highlightColor = $state('transparent');
let fontFamily = $state('Inter');
let fontSize = $state(14);
let textAlign = $state<'left' | 'center' | 'right' | 'justify'>('left');
let heading = $state<'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>('normal');
let spellcheck = $state(true);
/** The active note's saved line spacing; null when it has none (the view's default). */
let lineSpacing = $state<number | null>(null);
/** False when the focused editor isn't a note (a label or a title). */
let lineSpacingAvailable = $state(false);

export const toolbarStore = {
  get bold() { return bold; },
  get italic() { return italic; },
  get underline() { return underline; },
  get textColor() { return textColor; },
  get highlightColor() { return highlightColor; },
  get fontFamily() { return fontFamily; },
  get fontSize() { return fontSize; },
  get textAlign() { return textAlign; },
  get heading() { return heading; },
  get spellcheck() { return spellcheck; },
  get lineSpacing() { return lineSpacing; },
  get lineSpacingAvailable() { return lineSpacingAvailable; },

  /**
   * Updates all formatting state at once (called by the active Tiptap editor).
   */
  updateFromEditor(state: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    textColor?: string;
    highlightColor?: string;
    fontFamily?: string;
    fontSize?: number;
    textAlign?: 'left' | 'center' | 'right' | 'justify';
    heading?: 'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    lineSpacing?: number | null;
    lineSpacingAvailable?: boolean;
  }) {
    if (state.bold !== undefined) bold = state.bold;
    if (state.italic !== undefined) italic = state.italic;
    if (state.underline !== undefined) underline = state.underline;
    if (state.textColor !== undefined) textColor = state.textColor;
    if (state.highlightColor !== undefined) highlightColor = state.highlightColor;
    if (state.fontFamily !== undefined) fontFamily = state.fontFamily;
    if (state.fontSize !== undefined) fontSize = state.fontSize;
    if (state.textAlign !== undefined) textAlign = state.textAlign;
    if (state.heading !== undefined) heading = state.heading;
    if (state.lineSpacing !== undefined) lineSpacing = state.lineSpacing;
    if (state.lineSpacingAvailable !== undefined) lineSpacingAvailable = state.lineSpacingAvailable;
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
    textColor = '#ffffff';
    highlightColor = 'transparent';
    fontFamily = 'Inter';
    fontSize = 14;
    textAlign = 'left';
    heading = 'normal';
    lineSpacing = null;
    lineSpacingAvailable = false;
  },
};
