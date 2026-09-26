<script lang="ts">
  /**
   * NoteRawView — the note's whole file, frontmatter included, as plain text.
   *
   * It shows the bytes on disk (after every queued change has landed) and
   * follows the note while nothing is typed here. Edits save on blur, on
   * Ctrl+S, when the view closes and when the user switches back to the rich
   * editor. A save replaces the file only if it still holds the bytes this
   * view started from; if the note changed elsewhere meanwhile, nothing is
   * written and the user chooses between the new version and theirs (theirs
   * backs the other version up to `.filo/recovery/` first).
   *
   * While mounted the view is in the raw-view registry, so text typed here is
   * unsaved work to close, open-another-vault and quit. Text it closes with
   * and can't write (a conflict, a failure) is copied to `.filo/recovery/`.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { noteStore } from '../../stores/notes.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { rawTextForView } from '../../lib/notes/noteFile';
  import { backupThenRead } from '../../lib/vault/keepLocalBackup';
  import { reportError } from '../../lib/utils/errorBus';
  import { keepRawRescueCopy, registerRawView, type RawSaveResult } from '../../lib/notes/rawViews';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';

  let {
    path,
    readOnly = false,
  }: {
    /** The note's vault path. */
    path: string;
    /** The note can't be written (not UTF-8). */
    readOnly?: boolean;
  } = $props();

  /** Idle time before following a change made elsewhere. */
  const FOLLOW_MS = 150;

  let text = $state('');
  let baseText = $state('');
  let baseHash = $state<string | null>(null);
  let loading = $state(true);
  let unreadable = $state(false);
  let conflict = $state(false);
  let saving = $state(false);
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  /** The save running now, which a second save waits for. */
  let inFlight: Promise<RawSaveResult> | null = null;
  /** A leave-anyway already kept this text in `.filo/recovery/`. */
  let rescued = false;

  let dirty = $derived(baseHash !== null && text !== baseText);
  let model = $derived(noteStore.get(path));

  async function load(): Promise<void> {
    const snapshot = await noteStore.readRaw(path);
    if (destroyed) return;
    loading = false;
    if (!snapshot) {
      unreadable = true;
      return;
    }
    unreadable = false;
    baseText = rawTextForView(snapshot.raw);
    baseHash = snapshot.hash;
    text = baseText;
    conflict = false;
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

  async function writeTyped(): Promise<RawSaveResult> {
    const hash = baseHash;
    if (hash === null) return 'failed';
    saving = true;
    const sent = text;
    try {
      const result = await noteStore.writeRaw(path, sent, hash);
      if (result === 'conflict') {
        conflict = true;
        return 'conflict';
      }
      const after = await noteStore.readRaw(path);
      if (!after) {
        // On disk, but the view can't tell which bytes it now stands on.
        baseText = sent;
        return 'saved';
      }
      baseHash = after.hash;
      // Typing that went on during the save stays unsaved.
      baseText = text === sent ? rawTextForView(after.raw) : sent;
      if (text === sent) text = baseText;
      return 'saved';
    } catch (err) {
      reportError('NoteRawView.save', err, `Couldn't save "${path}"`);
      return 'failed';
    } finally {
      saving = false;
    }
  }

  function showTheirs(): void {
    void load();
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

  function onKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  }

  const unregister = registerRawView({
    path: () => path,
    isDirty: hasUnsavedText,
    inConflict: () => conflict,
    text: () => text,
    flush: save,
    markRescued: () => {
      rescued = true;
    },
  });

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    destroyed = true;
    unregister();
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
    if (rescued || (!hasUnsavedText() && !inFlight)) return;
    // Closing the view saves what was typed; the write outlives the view.
    // Text that can't land (the note changed elsewhere, the write failed,
    // or a save already running comes back with a conflict) is copied to
    // .filo/recovery/ rather than dropped.
    const closedPath = path;
    const typed = text;
    void (async () => {
      const result = await save();
      if (result === 'clean' || result === 'saved' || rescued) return;
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
      if (followTimer) clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        followTimer = null;
        if (!dirty && !saving && !conflict) void load();
      }, FOLLOW_MS);
    });
  });
</script>

<div class="note-raw-view">
  {#if conflict}
    <div class="raw-banner" role="alert">
      <span class="raw-banner-text">This note changed somewhere else since you started editing it here. Your text isn't saved yet.</span>
      <button type="button" class="raw-banner-action" onclick={showTheirs}>Show the new version</button>
      <button type="button" class="raw-banner-action" onclick={() => void keepMine()}>Keep mine</button>
    </div>
  {/if}
  {#if unreadable}
    <p class="raw-message" role="alert">Filo couldn't read this file.</p>
  {:else}
    <textarea
      class="raw-text"
      aria-label="Raw Markdown of {path}"
      spellcheck="false"
      disabled={loading}
      readonly={readOnly || closeDrainGate.draining}
      bind:value={text}
      onblur={() => void save()}
      onkeydown={onKeydown}
    ></textarea>
    <div class="raw-status" aria-live="polite">
      {#if readOnly}
        Read-only: this file isn't UTF-8.
      {:else if saving}
        Saving…
      {:else if dirty}
        Unsaved changes. Saves when you leave the field or press Ctrl+S.
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

  .raw-text {
    width: 100%;
    min-height: 480px;
    padding: 12px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    tab-size: 4;
    resize: vertical;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .raw-text:focus {
    outline: 2px solid var(--accent-primary, #3a86ff);
    outline-offset: -1px;
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
