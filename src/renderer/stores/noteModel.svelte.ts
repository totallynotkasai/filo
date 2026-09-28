/**
 * The note model: one open note as every view of it sees it, and the types
 * the note store (`notes.svelte.ts`) hands its views and prompt handlers.
 * The store owns the models and every change to them; this file holds only
 * their shape.
 */
import { SvelteMap } from 'svelte/reactivity';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { isLinkedNote, isNonUtf8 } from '../lib/vault/nonUtf8Paths.svelte';
import type { FreshRead } from '../lib/notes/noteWriter';
import type { DiskSnapshot } from '../lib/notes/noteFile';

export type ViewId = string;

/**
 * - `loading`: the first read hasn't finished.
 * - `ready`: the model holds the note.
 * - `missing`: the file isn't there (never was, or was deleted).
 * - `unreadable`: the read failed for another reason; editing waits for a retry.
 * - `conflict`: an unsaved body met a different body on disk; a prompt is up.
 */
export type NoteStatus = 'loading' | 'ready' | 'missing' | 'unreadable' | 'conflict';

/** What a view hands the store when it acquires a note. */
export interface ViewHooks {
  /** Push any keystrokes the view hasn't serialised yet into the model, now. */
  serialize?: () => void;
  /** True while the view holds keystrokes it hasn't serialised yet. */
  unserialised?: () => boolean;
  /**
   * The view's body as Markdown while it holds keystrokes the model refused
   * (a read-only or unreadable note), for a rescue copy; else null.
   */
  unserialisedBody?: () => string | null;
}

/** One open note. Reactive fields re-render every view that reads them. */
export class NoteModel {
  /** The note's path in its on-disk spelling. */
  relPath = $state('');
  status = $state<NoteStatus>('loading');
  /** Frontmatter on disk with any queued change laid over it. */
  frontmatter = $state.raw<Record<string, unknown>>({});
  /** The body every view shows (Markdown without frontmatter). */
  body = $state('');
  /** Bumps whenever `body` changes; `bodySource` says who changed it. */
  bodyRevision = $state(0);
  bodySource: ViewId | 'disk' = 'disk';
  /** The revision at which the body last changed without a view typing it (disk, reload, rewrite). */
  diskRevision = 0;
  /** True while an edited body hasn't reached disk. */
  hasUnsavedBody = $state(false);
  /** The view typing in the note (D7). */
  editorOwner = $state<ViewId | null>(null);
  /** The body can't round-trip through the editor, so it isn't written. */
  lossy = $state(false);
  /**
   * The `diskRevision` whose body the user chose to edit anyway (Take
   * ownership), or -1. Another view loading that same body must not freeze
   * the note again; a new body from disk can.
   */
  ownedDiskRevision = -1;
  /** Why the last read failed (status `unreadable`). */
  readError = $state<unknown>(null);
  /** The bytes the local state was built on. */
  base: DiskSnapshot | undefined = undefined;
  localBodyVersion = 0;
  /** The disk version waiting for the user's decision (status `conflict`). */
  conflictDisk: FreshRead | null = null;
  readonly views = new SvelteMap<ViewId, ViewHooks>();
  loaded: Promise<void> = Promise.resolve();

  constructor(relPath: string) {
    this.relPath = relPath;
  }

  get path(): VaultPath {
    return vaultPath(this.relPath);
  }

  /** Lossy, not UTF-8, or a symbolic link: shown, never written from an editor. */
  get readOnly(): boolean {
    return this.lossy || isNonUtf8(this.relPath) || isLinkedNote(this.relPath);
  }
}

/**
 * What became of a body handed to the note store:
 * - `queued`: it will be written (or already matches what is held);
 * - `read-only`: the note isn't UTF-8, or can't round-trip, so it is never written;
 * - `unreadable`: the note couldn't be read, so there is nothing to build on;
 * - `loading`: the note hasn't been read yet;
 * - `missing`: the file isn't there, so there is no version to build on;
 * - `not-open`: the view doesn't hold this note (left over from a closed vault);
 * - `vault-changed`: another vault opened while the note loaded.
 */
export type SetBodyStatus = 'queued' | 'read-only' | 'unreadable' | 'loading' | 'missing' | 'not-open' | 'vault-changed';

/**
 * A raw-view save. `conflict`: the file no longer held the bytes the save was
 * based on, so nothing was written. Otherwise `hash` names the bytes the file
 * holds from this save.
 */
export type RawWriteResult = { status: 'conflict' } | { status: 'written' | 'unchanged'; hash: string };

/** Conflict and deletion prompts, installed by `notePrompts.ts`. */
export interface NotePromptHandlers {
  conflict(model: NoteModel): void;
  deletedWithUnsavedBody(model: NoteModel): void;
  /**
   * A queued change couldn't be saved because the file is gone. `model` is
   * set when a body is among it (it can be saved as a new file).
   */
  writeTargetMissing(relPath: string, model: NoteModel | undefined): void;
  reloadShrank(model: NoteModel, priorBody: string): void;
  dismiss(relPath: string): void;
}
