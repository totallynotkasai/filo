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
 *   composition or holds keystrokes it hasn't serialised yet.
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
import { noteStore, type NoteModel } from '../../stores/notes.svelte';

/** Idle time before an editor's keystrokes are serialised into the note model. */
export const SERIALIZE_IDLE_MS = 150;

export class NoteEditorView {
  /** The note this view shows ('' for none). */
  private path = '';
  /** The model object and body revision the editor shows. */
  private shownModel: NoteModel | null = null;
  private shownRevision = -1;
  /** Keystrokes typed since the last serialise. */
  private unserialised = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True while this view loads a body into its editor (its onUpdate must not count it). */
  private loading = false;

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
    if (relPath) noteStore.acquire(relPath, this.viewId, { serialize: () => this.serialize() });
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
    this.unserialised = false;
    noteStore.setBody(m.relPath, editorMarkdown(editor), this.viewId);
    if (m.bodySource === this.viewId) {
      this.shownModel = m;
      this.shownRevision = m.bodyRevision;
    }
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
      this.shownRevision = revision;
      return;
    }
    if (this.unserialised || opts.composing) return;
    const firstLoad = this.shownRevision === -1;
    this.loading = true;
    try {
      const result = loadMarkdownIntoEditor(editor, m.body, { preserveSelection: !firstLoad });
      noteStore.setLossy(m.relPath, result.lossy);
    } finally {
      this.loading = false;
    }
    this.shownRevision = revision;
  }
}
