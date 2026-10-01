/**
 * When an inline title or label edit ends because the user went elsewhere.
 *
 * A tile, frame or connection title is typed in its own small editor and is
 * saved only when the edit ends. A press anywhere else ends it, and so does
 * focus moving elsewhere by other means (Tab). The formatting toolbar and the
 * popups it opens (the colour picker) don't, so a title can be made bold or
 * coloured mid-edit. Nor does Filo losing focus to another app: the editor
 * keeps focus, and a Windows shutdown meanwhile is held back by the
 * unsaved-state report, which counts a changed title like any other changed
 * field.
 *
 * The press is watched as well as focus because a press doesn't always move
 * focus: the Mind Map canvas cancels the press's default to pan, so a click
 * there leaves focus where it was (in a toolbar control, say). A focus move is
 * checked a moment later, not at once: a toolbar control may take focus
 * before its command puts it back in the editor.
 */

/** Where the user may go without ending the edit: the toolbar and the popups it opens. */
export const KEEPS_EDITING_SELECTOR = '.global-toolbar, [data-keeps-editor-focus]';

/** How long after focus leaves the edit is checked. */
export const TITLE_FOCUS_LEAVE_MS = 200;

/** Whether `el` (focused or pressed) keeps the edit in `host` open. */
export function keepsEditing(host: Element, el: Element | null): boolean {
  if (!el) return false;
  return host.contains(el) || el.closest(KEEPS_EDITING_SELECTOR) !== null;
}

/**
 * Calls `commit` when the user leaves the edit in `host`: at once on a press
 * outside it, or {@link TITLE_FOCUS_LEAVE_MS} after focus moved to a place
 * that doesn't keep it open. Every focus move in the document is watched, so
 * focus that went into the toolbar and from there elsewhere ends the edit
 * too. Returns the stop function, which also drops a pending check.
 */
export function commitWhenLeft(host: Element, commit: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onPointerDown = (e: Event): void => {
    // Before the toolbar's own press handling, which keeps focus in the editor.
    if (!keepsEditing(host, e.target instanceof Element ? e.target : null)) commit();
  };
  const onFocusOut = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!keepsEditing(host, document.activeElement)) commit();
    }, TITLE_FOCUS_LEAVE_MS);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('focusout', onFocusOut, true);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('focusout', onFocusOut, true);
  };
}
