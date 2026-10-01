/**
 * Detects whether an event target is an editable text element so callers can
 * leave a right-click there to the app's spell-check menu (main process: shown
 * only on a misspelled word; there is no cut / copy / paste menu) instead of
 * preempting it with a custom one.
 *
 * Returns true for contenteditable elements (TipTap editors), `<textarea>`,
 * and text-flavoured `<input>` types. Returns false for buttons, checkboxes,
 * ranges, and any non-editable element.
 */
export function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isContentEditableAware(target)) return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT') {
    const t = (target as HTMLInputElement).type.toLowerCase();
    return (
      t === '' ||
      t === 'text' ||
      t === 'search' ||
      t === 'email' ||
      t === 'url' ||
      t === 'tel' ||
      t === 'password' ||
      t === 'number'
    );
  }
  return false;
}

// `Element.isContentEditable` is correct in real browsers but unreliable in
// jsdom, so fall back to a manual ancestor walk that inspects the attribute.
function isContentEditableAware(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  let cur: HTMLElement | null = el;
  while (cur) {
    const v = cur.getAttribute('contenteditable');
    if (v !== null) {
      const norm = v.toLowerCase();
      if (norm === '' || norm === 'true' || norm === 'plaintext-only') return true;
      if (norm === 'false') return false;
    }
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Whether a right-click is left to the spell-check menu rather than Filo's:
 * on editable text, except a tile's or card's text (`data-tile-text`) that
 * isn't being edited. Such text shows its tile's or card's menu, loaded
 * editor or not; the text being typed in keeps spell-check (which shows
 * nothing on a word spelt right).
 */
export function wantsNativeTextMenu(e: MouseEvent): boolean {
  if (!isEditableTextTarget(e.target)) return false;
  const tileText = (e.target as HTMLElement).closest('[data-tile-text]');
  return tileText === null || tileText.contains(document.activeElement);
}

/**
 * A right or middle press on tile or card text that isn't being edited: the
 * browser would focus the text and move the caret into it first, so the
 * menu the right-click opens would lose its keys to the editor. The press
 * is kept from focusing it.
 */
export function keepFocusOnSecondaryPress(e: MouseEvent, host: Element): void {
  if (e.button !== 0 && !host.contains(document.activeElement)) e.preventDefault();
}

/**
 * The attribute a note editor carries (`createTiptapEditor`) and a title or
 * label editor doesn't. Both are `.ProseMirror` elements, but a note's
 * keystrokes reach the note store, while a title's are only in its editor
 * until the edit ends.
 */
export const NOTE_EDITOR_ATTRIBUTE = 'data-note-editor';

/** Whether `el` is in a note editor (not a title or label editor). */
export function isInNoteEditor(el: Element): boolean {
  return el.closest(`[${NOTE_EDITOR_ATTRIBUTE}]`) !== null;
}
