/**
 * Detects whether an event target is an editable text element so callers can
 * decide whether to defer to the browser's native context menu (spell-check
 * suggestions, cut/copy/paste) instead of preempting it with a custom one.
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
 * Whether a right-click gets the browser's own text menu (spell-check, cut /
 * copy / paste) rather than Filo's: on editable text, except a card's text
 * (`data-card-text`) that isn't being edited. A card shows its own menu
 * whether or not its editor has loaded yet, and the text menu once the user
 * is typing in it.
 */
export function wantsNativeTextMenu(e: MouseEvent): boolean {
  if (!isEditableTextTarget(e.target)) return false;
  const cardText = (e.target as HTMLElement).closest('[data-card-text]');
  return cardText === null || cardText.contains(document.activeElement);
}
