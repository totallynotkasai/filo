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
let lineSpacing = $state(1.5);

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
  },

  toggleSpellcheck() {
    spellcheck = !spellcheck;
    // Apply to all Tiptap editor elements
    document.querySelectorAll('.tiptap').forEach((el) => {
      (el as HTMLElement).setAttribute('spellcheck', String(spellcheck));
    });
  },

  setLineSpacing(value: number) {
    lineSpacing = value;
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
  },
};
