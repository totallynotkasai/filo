/**
 * Keeps main told whether leaving now could lose work, so that when Windows
 * asks to end the session main can answer at once: hold it back while Filo
 * saves and keeps rescue copies, or let it go (`main/services/sessionEnd.ts`).
 *
 * "Could lose work" covers anything unsaved, a change held for the user's
 * answer, unapplied Settings, and a focused text field whose text changed
 * since it took focus (a title or a filter that saves on blur may not be in
 * any writer yet). A tile, frame or connection title being typed is such a
 * field, though its editor is a `.ProseMirror` like a note's. A focused note
 * editor counts only through its unserialised keystrokes, which
 * `nothingUnsaved` already reports: counting the caret alone held back nearly
 * every Windows shutdown, since an editor keeps focus while Filo is in the
 * background, and a routine "preventing shutdown" screen teaches the click
 * that cuts a real rescue short.
 */
import { isEditableTextTarget, isInNoteEditor } from '../utils/editableTarget';

export interface UnsavedStateSources {
  nothingUnsaved: () => boolean;
  heldDecisionCount: () => number;
  openSettingsEdits: () => boolean;
}

/** The text a field holds now: an input's value, else its text. */
function fieldText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.textContent ?? '';
}

/**
 * True when the focused field (outside a note editor) holds text it didn't
 * hold when it took focus. `textAtFocus` has what each field held then; a
 * field with no record counts as changed. A note editor's keystrokes reach
 * `nothingUnsaved` through the note store instead.
 */
export function focusedFieldEdited(textAtFocus: WeakMap<Element, string>): boolean {
  const el = document.activeElement;
  if (!el || !isEditableTextTarget(el) || isInNoteEditor(el)) return false;
  const before = textAtFocus.get(el);
  return before === undefined || before !== fieldText(el);
}

export function mayLoseWorkNow(
  sources: UnsavedStateSources,
  textAtFocus: WeakMap<Element, string> = new WeakMap(),
): boolean {
  try {
    return (
      !sources.nothingUnsaved() ||
      sources.heldDecisionCount() > 0 ||
      sources.openSettingsEdits() ||
      focusedFieldEdited(textAtFocus)
    );
  } catch {
    // Can't tell: say yes, so a shutdown waits for the save.
    return true;
  }
}

/** How often the answer is checked between the events that change it. */
export const UNSAVED_STATE_POLL_MS = 1000;

/**
 * Sends `send(flag)` now and whenever the answer changes: checked on focus
 * moves, on typing, on `nudge()` (write-state changes), and every
 * {@link UNSAVED_STATE_POLL_MS} (Settings edits have no event). Returns the
 * stop function and the nudge.
 */
export function startUnsavedStateReport(
  sources: UnsavedStateSources,
  send: (mayLoseWork: boolean) => void,
): { stop: () => void; nudge: () => void } {
  let last: boolean | null = null;
  const textAtFocus = new WeakMap<Element, string>();
  const remember = (el: Element | null): void => {
    if (el && isEditableTextTarget(el) && !isInNoteEditor(el)) textAtFocus.set(el, fieldText(el));
  };
  remember(document.activeElement);
  const check = (): void => {
    const next = mayLoseWorkNow(sources, textAtFocus);
    if (next === last) return;
    last = next;
    try {
      send(next);
    } catch (err) {
      console.error('[unsavedStateReport] telling main failed:', err);
    }
  };
  // Focus leaves a field before the next one takes it: check once both are done.
  const onFocusChange = (): void => queueMicrotask(check);
  const onFocusIn = (event: FocusEvent): void => {
    remember(event.target instanceof Element ? event.target : null);
    onFocusChange();
  };
  // An editor takes a keystroke in its own handlers, after the event reaches
  // the document: check on the next task, once it has.
  let typed: ReturnType<typeof setTimeout> | null = null;
  const onInput = (): void => {
    typed ??= setTimeout(() => {
      typed = null;
      check();
    }, 0);
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusChange);
  document.addEventListener('input', onInput, true);
  const timer = setInterval(check, UNSAVED_STATE_POLL_MS);
  check();
  return {
    stop: () => {
      clearInterval(timer);
      if (typed !== null) clearTimeout(typed);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusChange);
      document.removeEventListener('input', onInput, true);
    },
    nudge: check,
  };
}
