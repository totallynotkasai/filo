<script lang="ts">
  /**
   * NoteRawView — the note's whole file, frontmatter included, as plain text.
   *
   * It shows the bytes on disk (after every queued change has landed) and
   * follows the note while nothing is typed here. Edits save once typing
   * pauses, on blur, on Ctrl+S, when the view closes and when the user
   * switches back to the rich editor. A save replaces the file only if it
   * still holds the bytes this view started from; if the note changed
   * elsewhere meanwhile, nothing is written and the user chooses between the
   * new version and theirs. Theirs backs the other version up to
   * `.filo/recovery/` first; the new version keeps a copy of theirs there.
   *
   * While mounted the view is in the raw-view registry, so text typed here is
   * unsaved work to close, open-another-vault and quit. Text it closes with
   * and can't write (a conflict, a failure) is copied to `.filo/recovery/`,
   * and so is text the writer won't take (the note stopped being UTF-8, or
   * became a link).
   *
   * The text field is CodeMirror (`lib/editor/rawTextEditor.ts`), loaded when
   * the view first opens so it stays out of the app's start-up bundle.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { noteStore } from '../../stores/notes.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { rawTextForView } from '../../lib/notes/noteFile';
  import { backupThenRead } from '../../lib/vault/keepLocalBackup';
  import { reportError } from '../../lib/utils/errorBus';
  import { keepRawRescueCopy, noteRawConflict, registerRawView, type RawSaveResult, type RawViewHandle } from '../../lib/notes/rawViews';
  import { keepNoteVersion } from '../../lib/notes/keepVersion';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { dropPendingPath, noteAdditionalPendingPath } from '../../lib/boards/writeStateTracking';
  import { getActiveVaultPath } from '../../lib/vault/activeVaultPath';
  import { isLinkedNote, isNonUtf8 } from '../../lib/vault/nonUtf8Paths.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultPath } from '@shared/vaultPath';
  import type { RawTextEditor } from '../../lib/editor/rawTextEditor';

  type RawTextEditorModule = typeof import('../../lib/editor/rawTextEditor');

  let {
    path: pathProp,
    readOnly = false,
  }: {
    /** The note's vault path. */
    path: string;
    /** The note can't be written (not UTF-8). */
    readOnly?: boolean;
  } = $props();

  /** Idle time before following a change made elsewhere. */
  const FOLLOW_MS = 150;
  /**
   * Idle time after typing before the text saves by itself, so a crash or a
   * power cut loses at most that much, not everything since the last blur.
   */
  const IDLE_SAVE_MS = 1500;

  let text = $state('');
  let baseText = $state('');
  let baseHash = $state<string | null>(null);
  let loading = $state(true);
  let unreadable = $state(false);
  let conflict = $state(false);
  let saving = $state(false);
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  /**
   * The note's path while the view is mounted. A pane switching to another
   * tab tears the view down after its tab has changed, so the `path` prop
   * can by then name the next tab's note, or none: every save, read and
   * rescue copy here goes by this instead. A rename while mounted moves it.
   */
  let path = $state(untrack(() => pathProp));
  $effect.pre(() => {
    const next = pathProp;
    if (!destroyed && next) path = next;
  });
  /** Where the text field goes. */
  let host = $state<HTMLDivElement | null>(null);
  let editorModule = $state.raw<RawTextEditorModule | null>(null);
  let editorFailed = $state(false);
  /** The text field, once its code has loaded. It shows `text` at all times. */
  let editor = $state.raw<RawTextEditor | null>(null);
  /** The save running now, which a second save waits for. */
  let inFlight: Promise<RawSaveResult> | null = null;
  /**
   * The text a leave-anyway kept in `.filo/recovery/`; null when none. Only
   * that exact text is withheld from the vault being let go: anything typed
   * after it (a leave called off, then more typing) saves as usual.
   */
  let rescuedText: string | null = null;
  /** The text last copied to `.filo/recovery/` because the writer wouldn't take it. */
  let skippedCopy: string | null = null;

  let dirty = $derived(baseHash !== null && text !== baseText);
  let model = $derived(noteStore.get(path));

  function isRescued(current: string): boolean {
    return rescuedText !== null && current === rescuedText;
  }

  /**
   * Shows `value`, read from disk, in the field. False, with nothing changed,
   * while the field can't take it (an IME composition is open).
   */
  function showText(value: string): boolean {
    if (editor && !editor.setText(value)) return false;
    text = value;
    return true;
  }

  function fieldEditable(): boolean {
    return !(readOnly || closeDrainGate.draining || loading);
  }

  /**
   * Reads the file and shows it. `follow` is a reload because the note
   * changed elsewhere: it gives way to anything that happened during its
   * read (typing, a save, a conflict) and tries again later instead.
   */
  async function load(follow = false): Promise<void> {
    const typedAtStart = text;
    const snapshot = await noteStore.readRaw(path);
    if (destroyed) return;
    loading = false;
    if (!snapshot) {
      unreadable = true;
      return;
    }
    if (text !== typedAtStart) return;
    if (follow && (saving || conflict)) {
      scheduleFollow();
      return;
    }
    const shown = rawTextForView(snapshot.raw);
    if (!showText(shown)) {
      scheduleFollow();
      return;
    }
    unreadable = false;
    baseText = shown;
    baseHash = snapshot.hash;
    conflict = false;
  }

  function scheduleFollow(): void {
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      if (destroyed) return;
      if (!dirty && !saving && !conflict) void load(true);
    }, FOLLOW_MS);
  }

  /** Text typed here that isn't on disk. Plain reads, so it still works after unmount. */
  function hasUnsavedText(): boolean {
    return !readOnly && baseHash !== null && text !== baseText;
  }

  /**
   * Writes what's typed, if anything, and says whether it is on disk. Safe to
   * call at any time: a call made while a save runs waits for it and then
   * looks again, so the answer is never about a save still in flight (a blur
   * starts one just before the Raw toggle asks).
   */
  export async function save(): Promise<RawSaveResult> {
    for (let round = 0; round < 3; round++) {
      while (inFlight) await inFlight.catch(() => undefined);
      if (!hasUnsavedText()) return 'clean';
      if (conflict) return 'conflict';
      const run = writeTyped();
      inFlight = run;
      let result: RawSaveResult;
      try {
        result = await run;
      } finally {
        if (inFlight === run) inFlight = null;
      }
      // Text typed while the write ran is still unsaved: go round again.
      if (result !== 'saved') return result;
    }
    return hasUnsavedText() ? 'failed' : 'saved';
  }

  /** A line waiting to be shown once the text is in (1-based; 0 for none). */
  let revealPending = 0;

  /** Selects line `line` (1-based) of the file and scrolls it into view. */
  export function revealLine(line: number): void {
    revealPending = line;
    applyReveal();
  }

  function applyReveal(): void {
    const ed = editor;
    if (!revealPending || !ed || loading) return;
    const line = revealPending;
    revealPending = 0;
    ed.revealLine(line);
  }

  // A line asked for before the text was in is shown once it is.
  $effect(() => {
    if (loading || !editor) return;
    untrack(applyReveal);
  });

  async function writeTyped(): Promise<RawSaveResult> {
    const hash = baseHash;
    if (hash === null) return 'failed';
    saving = true;
    const sent = text;
    try {
      const result = await noteStore.writeRaw(path, sent, hash);
      if (result.status === 'conflict') {
        conflict = true;
        return 'conflict';
      }
      if (result.status === 'skipped') {
        // The note can't be written any more; the field keeps the text.
        await keepSkippedText(sent);
        return 'failed';
      }
      // The view now stands on the bytes it wrote. A later read can't be the
      // base: it may already hold a change another view queued meanwhile (a
      // Task List tick, a tag), which the next save would then wipe unseen.
      baseHash = result.hash;
      baseText = sent;
      const after = await noteStore.readRaw(path);
      if (!after || after.hash === result.hash) {
        // The file shows as the view does (BOM and line ending aside).
        if (after && text === sent) {
          const shown = rawTextForView(after.raw);
          if (showText(shown)) baseText = shown;
        }
        return 'saved';
      }
      // Something landed on top of this save.
      if (text === sent) {
        // Nothing typed since: follow it (once a composition is over, if one is open).
        const shown = rawTextForView(after.raw);
        if (showText(shown)) {
          baseHash = after.hash;
          baseText = shown;
        } else {
          scheduleFollow();
        }
      } else {
        // Typing went on: it was built on the version before that change,
        // so the user decides (Keep mine backs the other version up first).
        conflict = true;
      }
      return 'saved';
    } catch (err) {
      reportError('NoteRawView.save', err, `Couldn't save "${path}"`);
      return 'failed';
    } finally {
      saving = false;
    }
  }

  /**
   * The writer left the file alone (it stopped being UTF-8 or became a link,
   * so the view turns read-only and its text no longer counts as unsaved):
   * the text goes to `.filo/recovery/`, once per text.
   */
  async function keepSkippedText(sent: string): Promise<void> {
    if (skippedCopy === sent) return;
    skippedCopy = sent;
    const why = isNonUtf8(path)
      ? "because the file isn't UTF-8 text any more"
      : isLinkedNote(path)
        ? 'because the note is now a link'
        : undefined;
    await keepRawRescueCopy(path, sent, 'failed', why);
  }

  /** Saves once typing has paused (after an IME composition, if one is open). */
  function scheduleIdleSave(): void {
    if (idleSaveTimer) clearTimeout(idleSaveTimer);
    idleSaveTimer = setTimeout(() => {
      idleSaveTimer = null;
      // A leave saves for itself; text a leave already kept a copy of stays out of the vault.
      if (destroyed || closeDrainGate.draining || isRescued(text)) return;
      if (editor?.composing()) {
        scheduleIdleSave();
        return;
      }
      void save();
    }, IDLE_SAVE_MS);
  }

  /**
   * "Use the new version": what was typed here is copied to `.filo/recovery/`
   * first (or, when no copy can be written, only on the user's say-so), then
   * the field shows the file.
   */
  async function useTheirs(): Promise<void> {
    const vaultRoot = getActiveVaultPath();
    const typed = text;
    if (vaultRoot && hasUnsavedText()) {
      const keptIn = await keepNoteVersion(vaultRoot, path, typed);
      if (destroyed) return;
      if (keptIn) {
        uiStore.pushToast({
          text: `What you typed in the raw view of "${path}" is saved in .filo/recovery/.`,
          type: 'info',
          duration: 10000,
          actions: [{ label: 'Show in folder', handler: () => void window.filo.invoke('shell:show-item-in-folder', keptIn) }],
        });
      } else {
        const discard = await uiStore.confirmAsync({
          title: 'Use the new version without a copy?',
          body: `Filo couldn't keep a copy of what you typed in the raw view of "${path}". Using the new version will lose it.`,
          confirmLabel: 'Use the new version',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!discard || destroyed) return;
      }
      // Typed while the copy was written: not in the copy, so not dropped.
      if (text !== typed) return;
    }
    await load();
  }

  async function keepMine(): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    // The hash the save is checked against must be of the bytes backed up.
    const got = await backupThenRead(vaultRoot, path, () => noteStore.readRaw(path));
    const latest = got.ok ? got.value : null;
    if (destroyed || !latest) return;
    baseHash = latest.hash;
    conflict = false;
    await save();
  }

  const handle: RawViewHandle = {
    path: () => path,
    isDirty: hasUnsavedText,
    inConflict: () => conflict,
    text: () => text,
    flush: save,
    markRescued: (kept) => {
      rescuedText = kept;
    },
    clearRescued: () => {
      rescuedText = null;
    },
    focus: () => {
      editor?.focus();
    },
  };
  const unregister = registerRawView(handle);

  // The field is made once its code and its host are both in, and goes with
  // the host. Changes reach `text` through `onChange`; text read from disk
  // reaches the field through `showText`, so nothing copies one into the other.
  $effect(() => {
    const el = host;
    const mod = editorModule;
    if (!el || !mod) return;
    const ed = untrack(() =>
      mod.createRawTextEditor(el, {
        text,
        label: `Raw Markdown of ${path}`,
        editable: fieldEditable(),
        onChange: (value) => {
          text = value;
          scheduleIdleSave();
        },
        onBlur: () => void save(),
        onSave: () => void save(),
      }),
    );
    editor = ed;
    return () => {
      ed.destroy();
      editor = null;
    };
  });

  $effect(() => {
    const ed = editor;
    const on = fieldEditable();
    if (ed) untrack(() => ed.allowEditing(on));
  });

  $effect(() => {
    const ed = editor;
    const label = `Raw Markdown of ${path}`;
    if (ed) untrack(() => ed.setLabel(label));
  });

  // The banner is a question only the user can answer: hold it as a decision.
  $effect(() => {
    const on = conflict;
    untrack(() => noteRawConflict(handle, on));
  });

  // Typed text counts as a pending write of the note while it is unsaved,
  // so the save indicator shows it and the crash sentinel names the note.
  let pendingPath: { root: string | undefined; path: string } | null = null;

  function setPending(on: boolean): void {
    if (pendingPath && (!on || vaultPath(pendingPath.path) !== vaultPath(path))) {
      const was = pendingPath;
      pendingPath = null;
      dropPendingPath(was.root, was.path);
    }
    if (on && !pendingPath) {
      pendingPath = { root: getActiveVaultPath() || undefined, path };
      noteAdditionalPendingPath(pendingPath.root, path);
    }
  }

  $effect(() => {
    const on = dirty && !readOnly;
    void path;
    untrack(() => setPending(on));
  });

  onMount(() => {
    void load();
    import('../../lib/editor/rawTextEditor').then(
      (mod) => {
        if (!destroyed) editorModule = mod;
      },
      (err: unknown) => {
        if (destroyed) return;
        editorFailed = true;
        reportError('NoteRawView.editor', err, `Couldn't open the raw view of "${path}"`);
      },
    );
  });

  onDestroy(() => {
    destroyed = true;
    unregister();
    // The teardown save below tracks its own write from here.
    setPending(false);
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
    if (idleSaveTimer) clearTimeout(idleSaveTimer);
    idleSaveTimer = null;
    if (isRescued(text) || (!hasUnsavedText() && !inFlight)) return;
    // Closing the view saves what was typed; the write outlives the view.
    // Text that can't land (the note changed elsewhere, the write failed,
    // or a save already running comes back with a conflict) is copied to
    // .filo/recovery/ rather than dropped.
    const closedPath = path;
    const typed = text;
    void (async () => {
      const result = await save();
      if (result === 'clean' || result === 'saved' || isRescued(typed)) return;
      await keepRawRescueCopy(closedPath, typed, result);
    })();
  });

  // Follow a change made elsewhere (another view, another program) while
  // nothing is typed here.
  $effect(() => {
    const m = model;
    if (!m) return;
    void m.bodyRevision;
    void m.frontmatter;
    untrack(() => {
      if (loading || dirty || saving || conflict) return;
      scheduleFollow();
    });
  });
</script>

<div class="note-raw-view">
  {#if conflict}
    <div class="raw-banner" role="alert">
      <span class="raw-banner-text">This note changed somewhere else since you started editing it here. Your text isn't saved yet.</span>
      <button type="button" class="raw-banner-action" onclick={() => void useTheirs()}>Use the new version (discard mine)</button>
      <button type="button" class="raw-banner-action" onclick={() => void keepMine()}>Keep mine</button>
    </div>
  {/if}
  {#if unreadable}
    <p class="raw-message" role="alert">Filo couldn't read this file.</p>
  {:else if editorFailed}
    <p class="raw-message" role="alert">Filo couldn't open the raw view.</p>
  {:else}
    <div class="raw-text" bind:this={host} aria-busy={loading || !editor}></div>
    <div class="raw-status" aria-live="polite">
      {#if readOnly}
        {isLinkedNote(path) ? 'Read-only: this note is a link; edit the original.' : "Read-only: this file isn't UTF-8."}
      {:else if saving}
        Saving…
      {:else if dirty}
        Unsaved changes. Saves when you pause, leave the field or press Ctrl+S.
      {/if}
    </div>
  {/if}
</div>

<style>
  .note-raw-view {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /*
   * The text field (CodeMirror). The box is the textarea's: at least 480 px,
   * resizable vertically, scrolling inside. Every colour is a theme token, so
   * each theme keeps its contrast; these rules outrank CodeMirror's base
   * stylesheet by one class.
   */
  .raw-text :global(.cm-editor) {
    height: 480px;
    min-height: 480px;
    resize: vertical;
    overflow: hidden;
    /* CodeMirror's sticky gutter and find bar stack above the text only. */
    isolation: isolate;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
  }

  .raw-text :global(.cm-editor.cm-focused) {
    outline: 2px solid var(--accent-primary, #3a86ff);
    outline-offset: -1px;
  }

  .raw-text :global(.cm-scroller) {
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    /* The file as written: Cascadia Code would draw `<!--` and `-->` as arrows. */
    font-variant-ligatures: none;
  }

  .raw-text :global(.cm-content) {
    padding: 12px 0;
    caret-color: var(--text-primary);
  }

  .raw-text :global(.cm-line) {
    padding: 0 12px 0 8px;
  }

  .raw-text :global(.cm-gutters) {
    border-right: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--text-tertiary);
  }

  .raw-text :global(.cm-lineNumbers .cm-gutterElement) {
    padding: 0 8px 0 12px;
  }

  /* A zero-width space, a stray BOM, a control character. */
  .raw-text :global(.cm-specialChar) {
    color: var(--accent-danger);
  }

  /* Markdown: markup reads as markup; the words keep the text colour. */
  .raw-text :global(.tok-heading),
  .raw-text :global(.tok-strong) {
    font-weight: 700;
  }

  .raw-text :global(.tok-emphasis) {
    font-style: italic;
  }

  .raw-text :global(.tok-strikethrough) {
    text-decoration: line-through;
  }

  .raw-text :global(.tok-link) {
    text-decoration: underline;
    text-decoration-color: var(--accent-primary);
  }

  .raw-text :global(.tok-quote) {
    color: var(--text-secondary);
  }

  .raw-text :global(.tok-monospace) {
    border-radius: 3px;
    background: var(--ui-surface);
  }

  .raw-text :global(.tok-meta),
  .raw-text :global(.tok-url),
  .raw-text :global(.tok-comment) {
    color: var(--text-tertiary);
    text-decoration: none;
  }

  .raw-text :global(.tok-comment) {
    font-style: italic;
  }

  /* The frontmatter: values muted, keys stronger, fences as markup. */
  .raw-text :global(.cm-filo-fm),
  .raw-text :global(.cm-filo-fm [class*='tok-']) {
    color: var(--text-secondary);
    font-weight: normal;
    font-style: normal;
    text-decoration: none;
    background: none;
  }

  .raw-text :global(.cm-filo-fm-key),
  .raw-text :global(.cm-filo-fm-key [class*='tok-']) {
    color: var(--text-primary);
    font-weight: 600;
  }

  .raw-text :global(.cm-filo-fm-fence),
  .raw-text :global(.cm-filo-fm-fence [class*='tok-']) {
    color: var(--text-tertiary);
  }

  /* The line "Edit in Raw view" named, until it is edited. */
  .raw-text :global(.cm-filo-named-line) {
    background: var(--ui-warn-bg);
    box-shadow: inset 3px 0 0 var(--ui-warn-border);
  }

  .raw-text :global(.cm-filo-named-line),
  .raw-text :global(.cm-filo-named-line [class*='tok-']),
  .raw-text :global(.cm-filo-named-line [class*='cm-filo-fm']) {
    color: var(--ui-warn-text);
  }

  .raw-text :global(.cm-filo-named-line [class*='tok-']) {
    background: none;
  }

  /* The find bar (Ctrl+F). */
  .raw-text :global(.cm-panels) {
    background: var(--ui-bg-secondary);
    color: var(--text-primary);
    font-family: var(--font-system);
  }

  .raw-text :global(.cm-panels-top) {
    border-bottom: 1px solid var(--ui-border);
  }

  .raw-text :global(.cm-textfield) {
    border: 1px solid var(--ui-border);
    border-radius: 3px;
    background: var(--ui-bg);
    color: var(--text-primary);
  }

  .raw-text :global(.cm-textfield:focus) {
    outline: 2px solid var(--accent-primary, #3a86ff);
    outline-offset: -1px;
  }

  .raw-text :global(.cm-button) {
    border: 1px solid var(--ui-border);
    border-radius: 3px;
    background: var(--ui-surface);
    background-image: none;
    color: var(--text-primary);
  }

  .raw-text :global(.cm-button:hover) {
    background: var(--ui-surface-hover);
  }

  .raw-text :global(.cm-panel button[name='close']) {
    color: var(--text-secondary);
  }

  .raw-text :global(.cm-panel input[type='checkbox']) {
    accent-color: var(--accent-primary);
  }

  .raw-text :global(.cm-searchMatch) {
    outline: 1px solid var(--accent-primary);
    background: var(--accent-primary-alpha);
  }

  .raw-text :global(.cm-searchMatch-selected) {
    outline-width: 2px;
    background: var(--selection-bg);
  }

  .raw-status {
    min-height: 16px;
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .raw-message {
    color: var(--text-secondary);
    font-size: 13px;
  }

  .raw-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--ui-warn-border, #f59e0b);
    border-radius: 4px;
    background: var(--ui-warn-bg, #fef3c7);
    color: var(--ui-warn-text, #92400e);
    font-size: 13px;
  }

  .raw-banner-text {
    flex: 1;
    min-width: 200px;
  }

  .raw-banner-action {
    padding: 4px 10px;
    border: 1px solid var(--ui-warn-border, #f59e0b);
    border-radius: 4px;
    background: transparent;
    color: var(--ui-warn-text, #92400e);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .raw-banner-action:hover {
    background: var(--ui-warn-bg-hover, #fcd34d);
  }
</style>
