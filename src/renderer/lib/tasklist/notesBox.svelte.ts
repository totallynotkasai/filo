/**
 * NotesBox — the Task List row's notes box: a draft of the task note's body,
 * and when that draft may be written.
 *
 * The box copies the note's body into a draft when it opens. The body can
 * change after that (a Document tab, another program): until the user types
 * in the box it follows the note (`follow`), so it never shows, or writes, an
 * older version. Once they type, it writes only what they typed, and only
 * onto the body the draft was taken from; a body that changed meanwhile gets
 * the note conflict question instead.
 *
 * A write the note store refuses (the note isn't UTF-8, can't be read, or
 * another vault opened) keeps the box open with the draft in it and says why.
 * The body passed in is the note's body, never a whole file: the note store
 * and the vault index both hold it without the frontmatter.
 *
 * The draft lives only in the box until it saves: once typing pauses
 * (`IDLE_SAVE_MS`), on blur, and on Escape or Ctrl+Enter, which also close
 * the box. So a mounted box
 * holding typed text that isn't in the note (a conflict waiting for its
 * answer, a refused write) counts as unsaved work: close, open-another-vault
 * and quit name it and keep a rescue copy of it, and their save hands it to
 * the note first. A box that unmounts with a conflict still open stays counted
 * until the conflict is answered.
 *
 * The box shows the body with its line breaks as plain newlines, and a draft
 * goes to the note as typed, each newline a plain newline
 * (`notesBoxMarkdown.ts`). Everything that compares the draft with the note
 * compares it in that body form; a rescue copy keeps the draft as typed.
 */
import { vaultPath } from '@shared/vaultPath';
import { localNoteText, newNoteText, sameBody } from '../notes/noteFile';
import { noteStore, type SetBodyStatus } from '../../stores/notes.svelte';
import { noteFrontmatter } from '../../stores/noteMeta';
import { promptNotesBoxConflict } from '../../stores/notePrompts';
import { uiStore } from '../../stores/ui.svelte';
import { isLinkedNote, isNonUtf8 } from '../vault/nonUtf8Paths.svelte';
import { registerUnsavedSource } from '../boards/writeStateTracking';
import { registerComponentFlush } from '../boards/componentFlush';
import { bodyToBoxText, boxTextToBody } from './notesBoxMarkdown';

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

/**
 * Idle time after typing before the draft saves by itself, so a crash or a
 * power cut loses at most that much, not everything since the last blur.
 */
const IDLE_SAVE_MS = 1500;

export interface NotesBoxDeps {
  /** The task note's path ('' for a row without a note). */
  path(): string;
  /** The note's body now. */
  body(): string;
  /** Hands a body to the note store; absent when the row can't take notes. */
  write: ((body: string) => Promise<SetBodyStatus>) | undefined;
}

// Not reactive: read only when the leave, quit and rescue paths ask.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const boxes = new Set<NotesBox>(); // allow-module-state: holds mounted boxes (and unmounted ones with a conflict still open); a vault swap unmounts every box and clears the conflict prompts

/** Boxes holding typed text that isn't in their note. */
function unsavedBoxes(): NotesBox[] {
  return [...boxes].filter((b) => b.unsaved);
}

/** True when a notes box of `path` holds a draft waiting for a conflict answer. */
export function notesBoxInConflict(path: string): boolean {
  const key = vaultPath(path);
  return unsavedBoxes().some((b) => b.inConflict && vaultPath(b.path) === key);
}

/** The spelling of an unsaved draft's note path, for the leave dialog. */
export function notesBoxDraftPath(key: string): string | undefined {
  return unsavedBoxes().find((b) => vaultPath(b.path) === key)?.path;
}

/**
 * Each unsaved draft as a rescue item: the note's frontmatter over the draft,
 * so the copy is the note as the user meant it.
 */
export function takeNotesBoxRescueItems(): Array<{ relPath: string; text: string }> {
  return unsavedBoxes().map((b) => ({ relPath: b.path, text: b.rescueText() }));
}

export class NotesBox {
  expanded = $state(false);
  draft = $state('');
  private touched = false;
  private openedBody = '';
  private conflictOpen = false;
  private mounted = false;
  private idleSave: ReturnType<typeof setTimeout> | null = null;
  // The row's props can't be read once it has unmounted (its task gone), and
  // a box with a conflict still open outlives it: the last values read stand in.
  private lastPath = '';
  private lastBody = '';

  constructor(private readonly deps: NotesBoxDeps) {}

  /** The task note's path. */
  get path(): string {
    try {
      this.lastPath = this.deps.path();
    } catch {
      // The row is gone: keep the last path read.
    }
    return this.lastPath;
  }

  /** The note's body now (the last one read, once the row is gone). */
  private body(): string {
    try {
      this.lastBody = this.deps.body();
    } catch {
      // The row is gone: keep the last body read.
    }
    return this.lastBody;
  }

  /** The draft as the note's body. */
  private draftBody(): string {
    return boxTextToBody(this.draft);
  }

  /** The user typed text that isn't in the note. */
  get unsaved(): boolean {
    return this.touched && this.path !== '' && !sameBody(this.draftBody(), this.body());
  }

  /** The draft waits for the conflict question's answer. */
  get inConflict(): boolean {
    return this.conflictOpen;
  }

  /** The whole note as the draft would make it. */
  rescueText(): string {
    const model = noteStore.get(this.path);
    if (model?.base) return localNoteText(model.base, model.frontmatter, this.draft);
    return newNoteText({ ...noteFrontmatter(this.path) }, this.draft);
  }

  /**
   * Called from the row's `$effect`: counts the box's draft as unsaved work
   * and lets the save hand it to the note. The returned teardown saves the
   * draft; a box whose conflict is still open stays counted until it is answered.
   */
  track(): () => void {
    boxes.add(this);
    this.mounted = true;
    const offFlush = registerComponentFlush('task notes', () => this.save(false));
    return () => {
      offFlush();
      this.cancelIdleSave();
      this.mounted = false;
      if (!this.touched) {
        this.forgetIfDone();
        return;
      }
      void this.save(false)
        .catch((err: unknown) => console.warn('[notesBox] saving the draft on unmount failed:', err))
        .finally(() => this.forgetIfDone());
    };
  }

  private forgetIfDone(): void {
    if (!this.mounted && !this.conflictOpen) boxes.delete(this);
  }

  /** Why the note can't be written from here (the box is then read-only), or null. */
  get readOnlyReason(): string | null {
    const path = this.path;
    if (!path) return null;
    if (isNonUtf8(path)) return "This note isn't UTF-8, so Filo won't save it. Convert it from its Document tab.";
    if (isLinkedNote(path)) return 'This note is a link; edit the original.';
    if (noteStore.get(path)?.readOnly) return "This note has formatting Filo can't keep, so it isn't saved from here. Edit it in its Document tab.";
    return null;
  }

  open(): void {
    const body = this.body();
    this.draft = bodyToBoxText(body);
    this.openedBody = body;
    this.touched = false;
    this.expanded = true;
  }

  /**
   * Keeps an open box the user hasn't typed in showing the note as it is now:
   * the row's `$effect` calls this, so it re-runs when the note's body
   * changes. A box with typing in it keeps the typing; its save asks.
   */
  follow(): void {
    const body = this.body();
    if (!this.expanded || this.touched || this.conflictOpen || sameBody(body, this.openedBody)) return;
    this.draft = bodyToBoxText(body);
    this.openedBody = body;
  }

  /** The user typed in the box: it saves once typing pauses. */
  typed(): void {
    this.touched = true;
    this.cancelIdleSave();
    this.idleSave = setTimeout(() => {
      this.idleSave = null;
      // A conflict question already holds the draft; the answer writes it.
      if (!this.mounted || this.conflictOpen) return;
      void this.save(false).catch((err: unknown) => console.warn('[notesBox] saving the draft after a pause failed:', err));
    }, IDLE_SAVE_MS);
  }

  private cancelIdleSave(): void {
    if (this.idleSave) clearTimeout(this.idleSave);
    this.idleSave = null;
  }

  /** The box got focus: a note that couldn't be read is tried again. */
  focused(): void {
    const path = this.path;
    if (path && noteStore.get(path)?.status === 'unreadable') void noteStore.reload(path);
  }

  /** Writes what the user typed, if anything; `close` also folds the box. */
  async save(close: boolean): Promise<void> {
    this.cancelIdleSave();
    if (close) this.expanded = false;
    const write = this.deps.write;
    if (!write) return;
    const currentBody = this.body();
    const sent = this.draftBody();
    const decision = notesBoxDecision({ touched: this.touched, openedBody: this.openedBody, currentBody, draft: sent });
    if (decision === 'skip') return;
    const path = this.path;
    if (decision === 'conflict') {
      this.expanded = true;
      this.conflictOpen = true;
      promptNotesBoxConflict(path, () => this.draftBody(), {
        onKept: (status) => {
          this.conflictOpen = false;
          this.written(status, this.draftBody());
          this.forgetIfDone();
        },
        onUseTheirs: () => {
          this.conflictOpen = false;
          this.open();
          this.forgetIfDone();
        },
        stillHeld: () => this.conflictOpen && this.unsaved,
        rescueText: () => this.rescueText(),
      });
      return;
    }
    this.written(await write(sent), sent);
  }

  private written(status: SetBodyStatus, sent: string): void {
    if (status === 'queued') {
      this.openedBody = sent;
      if (this.draftBody() === sent) this.touched = false;
      return;
    }
    // The draft is the only copy: keep it in front of the user.
    this.expanded = true;
    uiStore.toast(`"${this.path}" ${REFUSED[status]}`, 'error', 10000);
  }
}

registerUnsavedSource(() => unsavedBoxes().map((b) => b.path));
