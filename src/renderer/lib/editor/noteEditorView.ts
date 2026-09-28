/**
 * noteEditorView — ties one TipTap editor to the shared note model.
 *
 * Every editor that shows a note (a text tile, a Document tab) is a view of
 * the one `NoteModel` in `noteStore`. This helper does the view's half:
 *
 * - Keystrokes are serialised to Markdown at most once per ~150 ms of idle,
 *   and at once on blur, destroy or when the store asks (save, a disk
 *   change). Serialising a 50 KB note on every keystroke is what the idle
 *   debounce avoids.
 * - A view that typed becomes the note's editor owner (D7). Its own body
 *   changes never load back into it, so the caret and undo history stay put.
 * - Every other change to the model's body (another view typed, the disk
 *   changed, a reload) loads into the editor, unless this view is mid-IME
 *   composition or holds keystrokes it hasn't serialised yet. Those
 *   keystrokes were typed into the body the model has since replaced, so
 *   when they are serialised the store holds them in conflict with it (the
 *   one prompt) rather than writing them over the change.
 * - A load that turns out lossy (the editor can't reproduce the Markdown)
 *   marks the note read-only.
 *
 * The component calls `sync()` from an `$effect` that reads the model's
 * `bodyRevision` and `status`, so a change re-runs it.
 *
 * The view names its note by path and looks the model up on each use: a
 * rename can move a different model object to the path the view shows.
 */
import type { Editor } from '@tiptap/core';
import { editorMarkdown, loadMarkdownIntoEditor } from './markdownSync';
import { vaultPath } from '@shared/vaultPath';
import { noteStore, type NoteModel, type SetBodyStatus } from '../../stores/notes.svelte';
import { reportError } from '../utils/errorBus';

/** Idle time before an editor's keystrokes are serialised into the note model. */
export const SERIALIZE_IDLE_MS = 150;

/** Why the note model didn't take an editor's text, in the user's words. */
const REFUSAL_TEXT: Partial<Record<SetBodyStatus, string>> = {
  'read-only': 'the note is read-only',
  unreadable: "Filo couldn't read the note",
  missing: 'the file no longer exists',
  'not-open': 'the note is no longer open',
  'vault-changed': 'another vault is open',
};

export class NoteEditorView {
  /** The note this view shows ('' for none). */
  private path = '';
  /** The model object and body revision the editor shows. */
  private shownModel: NoteModel | null = null;
  private shownRevision = -1;
  /** The model body at `shownRevision`: what the editor's text was built on. */
  private shownBody = '';
  /** Keystrokes typed since the last serialise. */
  private unserialised = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True while this view loads a body into its editor (its onUpdate must not count it). */
  private loading = false;
  /** The Markdown the model last refused, kept for a rescue copy. */
  private refusedBody: string | null = null;
  /** The refusal last reported, so the same one isn't said at every keystroke. */
  private refusedStatus: SetBodyStatus | null = null;

  constructor(
    readonly viewId: string,
    private readonly getEditor: () => Editor | null,
  ) {}

  /** The model of the note this view shows, if one is loaded. */
  get model(): NoteModel | null {
    return this.path ? (noteStore.get(this.path) ?? null) : null;
  }

  /** Shows the note at `relPath` (or nothing). Idempotent for the same note. */
  show(relPath: string): void {
    if (this.path && vaultPath(this.path) !== vaultPath(relPath)) {
      this.serialize();
      // A rename sweep may already have moved the old note to the new path;
      // then there is nothing to leave.
      const old = noteStore.get(this.path);
      if (old && vaultPath(old.relPath) === vaultPath(this.path)) noteStore.release(this.path, this.viewId);
    }
    this.path = relPath;
    if (relPath) {
      noteStore.acquire(relPath, this.viewId, {
        serialize: () => this.serialize(),
        unserialised: () => this.unserialised,
        unserialisedBody: () => (this.unserialised ? this.refusedBody : null),
      });
    }
  }

  /** Stops showing the note (component destroy). Unsaved keystrokes are kept. */
  close(): void {
    this.serialize();
    const m = this.model;
    if (m) noteStore.release(m.relPath, this.viewId);
    this.path = '';
  }

  /**
   * The editor's onUpdate. Returns false for an update this view caused by
   * loading the model (not a user edit).
   */
  edited(): boolean {
    if (this.loading) return false;
    this.unserialised = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.serialize(), SERIALIZE_IDLE_MS);
    return true;
  }

  /** Pushes unserialised keystrokes into the model now. */
  serialize(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const editor = this.getEditor();
    const m = this.model;
    if (!this.unserialised || !editor || editor.isDestroyed || !m) return;
    let markdown: string;
    let status: SetBodyStatus;
    try {
      markdown = editorMarkdown(editor);
      // The body changed underneath (disk, reload, rewrite) since the editor
      // last showed the model: the text was built on the old one.
      const superseded = m === this.shownModel && this.shownRevision >= 0 && m.diskRevision > this.shownRevision;
      status = superseded
        ? noteStore.setBodyBuiltOn(m.relPath, markdown, this.viewId, this.shownBody)
        : noteStore.setBody(m.relPath, markdown, this.viewId);
    } catch (err) {
      // The keystrokes are still only in the editor: they stay counted as
      // unsaved (close and quit ask, and keep a rescue copy), and the user
      // is told which note.
      reportError('noteEditor.serialize', err, `Couldn't take your latest edits to "${m.relPath}" from the editor, so they aren't saved yet.`, m.relPath);
      return;
    }
    if (status === 'missing' && noteStore.holdBodyOfMissing(m.relPath, markdown, this.viewId)) status = 'queued';
    if (status !== 'queued') {
      this.refused(m, status, markdown);
      return;
    }
    this.unserialised = false;
    this.refusedBody = null;
    this.refusedStatus = null;
    if (m.bodySource === this.viewId) this.markShown(m);
  }

  /**
   * The model didn't take the keystrokes. They stay unserialised, so leave
   * and quit still count them, and the rescue copy takes this text. A note
   * still loading takes them once it has loaded; any other refusal is said
   * once, naming the note.
   */
  private refused(m: NoteModel, status: SetBodyStatus, markdown: string): void {
    this.refusedBody = markdown;
    if (status === 'loading') {
      void m.loaded.then(() => {
        if (this.unserialised && this.model === m) this.serialize();
      });
      return;
    }
    if (this.refusedStatus === status) return;
    this.refusedStatus = status;
    reportError(
      'noteEditor.serialize',
      new Error(`note ${status}`),
      `Your latest edits to "${m.relPath}" can't be saved (${REFUSAL_TEXT[status] ?? status}). Filo keeps them in the editor, and closing or quitting will keep a copy.`,
      m.relPath,
    );
  }

  /** True while keystrokes wait to be serialised. */
  get hasUnserialised(): boolean {
    return this.unserialised;
  }

  /**
   * Loads the model's body into the editor when it changed elsewhere. Call
   * from an `$effect` that reads `model.bodyRevision` and `model.status`.
   */
  sync(opts: { composing: boolean }): void {
    const m = this.model;
    const editor = this.getEditor();
    if (!m || !editor || editor.isDestroyed) return;
    if (m.status === 'loading' || m.status === 'unreadable') return;
    if (m !== this.shownModel) {
      this.shownModel = m;
      this.shownRevision = -1;
    }
    const revision = m.bodyRevision;
    if (revision === this.shownRevision) return;
    if (m.bodySource === this.viewId) {
      this.markShown(m);
      return;
    }
    if (this.unserialised || opts.composing) return;
    const firstLoad = this.shownRevision === -1;
    this.loading = true;
    try {
      const result = loadMarkdownIntoEditor(editor, m.body, { preserveSelection: !firstLoad });
      // Only a body that came from disk says anything about the file. A body
      // another view typed is that editor's own output, so it can't make the
      // note read-only under the view the user is typing in.
      if (m.bodySource === 'disk') noteStore.setLossy(m.relPath, result.lossy);
    } finally {
      this.loading = false;
    }
    this.markShown(m);
  }

  private markShown(m: NoteModel): void {
    this.shownModel = m;
    this.shownRevision = m.bodyRevision;
    this.shownBody = m.body;
  }
}
