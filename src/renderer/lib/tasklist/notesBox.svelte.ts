/**
 * NotesBox — the Task List row's notes box: a draft of the task note's body,
 * and when that draft may be written.
 *
 * The box copies the note's body into a draft when it opens. The body can
 * change after that (a Document tab, another program), so "the draft differs
 * from the body" doesn't mean the user typed anything; writing on that test
 * alone put a stale draft back over the newer edit. So the box writes only
 * what the user typed, and only onto the body the draft was taken from; a
 * body that changed meanwhile gets the note conflict question instead.
 *
 * A write the note store refuses (the note isn't UTF-8, can't be read, or
 * another vault opened) keeps the box open with the draft in it and says why.
 * The body passed in is the note's body, never a whole file: the note store
 * and the vault index both hold it without the frontmatter.
 */
import { sameBody } from '../notes/noteFile';
import { noteStore, type SetBodyStatus } from '../../stores/notes.svelte';
import { promptNotesBoxConflict } from '../../stores/notePrompts';
import { uiStore } from '../../stores/ui.svelte';
import { isLinkedNote, isNonUtf8 } from '../vault/nonUtf8Paths.svelte';

export interface NotesBoxState {
  /** The user typed in the box since it opened (or since its last write). */
  touched: boolean;
  /** The body the draft was taken from. */
  openedBody: string;
  /** The note's body now. */
  currentBody: string;
  draft: string;
}

/**
 * - `skip`: nothing of the user's to write;
 * - `write`: the draft goes onto the body it was taken from;
 * - `conflict`: the note changed since the box opened; ask before writing.
 */
export type NotesBoxDecision = 'skip' | 'write' | 'conflict';

export function notesBoxDecision(s: NotesBoxState): NotesBoxDecision {
  if (!s.touched || sameBody(s.draft, s.currentBody)) return 'skip';
  if (!sameBody(s.openedBody, s.currentBody)) return 'conflict';
  return 'write';
}

const REFUSED: Record<Exclude<SetBodyStatus, 'queued'>, string> = {
  'read-only': "isn't UTF-8 (or its formatting can't be kept), so Filo won't save it. Convert it from its Document tab.",
  unreadable: "couldn't be read, so your note wasn't saved. It's still in the box.",
  loading: "hasn't finished loading, so your note wasn't saved. It's still in the box.",
  missing: "isn't in the vault any more, so your note wasn't saved. It's still in the box.",
  'not-open': "isn't open in this vault any more, so your note wasn't saved.",
  'vault-changed': 'belongs to the vault you left, so your note wasn\'t saved.',
};

export interface NotesBoxDeps {
  /** The task note's path ('' for a row without a note). */
  path(): string;
  /** The note's body now. */
  body(): string;
  /** Hands a body to the note store; absent when the row can't take notes. */
  write: ((body: string) => Promise<SetBodyStatus>) | undefined;
}

export class NotesBox {
  expanded = $state(false);
  draft = $state('');
  private touched = false;
  private openedBody = '';

  constructor(private readonly deps: NotesBoxDeps) {}

  /** Why the note can't be written from here (the box is then read-only), or null. */
  get readOnlyReason(): string | null {
    const path = this.deps.path();
    if (!path) return null;
    if (isNonUtf8(path)) return "This note isn't UTF-8, so Filo won't save it. Convert it from its Document tab.";
    if (isLinkedNote(path)) return 'This note is a link; edit the original.';
    if (noteStore.get(path)?.readOnly) return "This note has formatting Filo can't keep, so it isn't saved from here. Edit it in its Document tab.";
    return null;
  }

  open(): void {
    const body = this.deps.body();
    this.draft = body;
    this.openedBody = body;
    this.touched = false;
    this.expanded = true;
  }

  /** The user typed in the box. */
  typed(): void {
    this.touched = true;
  }

  /** The box got focus: a note that couldn't be read is tried again. */
  focused(): void {
    const path = this.deps.path();
    if (path && noteStore.get(path)?.status === 'unreadable') void noteStore.reload(path);
  }

  /** Esc: drop the draft. */
  cancel(): void {
    this.expanded = false;
    this.draft = this.deps.body();
    this.touched = false;
  }

  /** Writes what the user typed, if anything; `close` also folds the box. */
  async save(close: boolean): Promise<void> {
    if (close) this.expanded = false;
    const write = this.deps.write;
    if (!write) return;
    const currentBody = this.deps.body();
    const sent = this.draft;
    const decision = notesBoxDecision({ touched: this.touched, openedBody: this.openedBody, currentBody, draft: sent });
    if (decision === 'skip') return;
    const path = this.deps.path();
    if (decision === 'conflict') {
      this.expanded = true;
      promptNotesBoxConflict(path, sent, {
        onKept: (status) => this.written(status, sent),
        onUseTheirs: () => this.open(),
      });
      return;
    }
    this.written(await write(sent), sent);
  }

  private written(status: SetBodyStatus, sent: string): void {
    if (status === 'queued') {
      this.openedBody = sent;
      if (this.draft === sent) this.touched = false;
      return;
    }
    // The draft is the only copy: keep it in front of the user.
    this.expanded = true;
    uiStore.toast(`"${this.deps.path()}" ${REFUSED[status]}`, 'error', 10000);
  }
}
