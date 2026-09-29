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
  import { keepRawRescueCopy, noteRawConflict, registerRawView, type RawSaveResult, type RawViewHandle } from '../../lib/notes/rawViews';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { dropPendingPath, noteAdditionalPendingPath } from '../../lib/boards/writeStateTracking';
  import { getActiveVaultPath } from '../../lib/vault/activeVaultPath';
  import { vaultPath } from '@shared/vaultPath';

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
  let textarea = $state<HTMLTextAreaElement | null>(null);
  /** The save running now, which a second save waits for. */
  let inFlight: Promise<RawSaveResult> | null = null;
  /**
   * The text a leave-anyway kept in `.filo/recovery/`; null when none. Only
   * that exact text is withheld from the vault being let go: anything typed
   * after it (a leave called off, then more typing) saves as usual.
   */
  let rescuedText: string | null = null;

  let dirty = $derived(baseHash !== null && text !== baseText);
  let model = $derived(noteStore.get(path));

  function isRescued(current: string): boolean {
    return rescuedText !== null && current === rescuedText;
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
    unreadable = false;
    baseText = rawTextForView(snapshot.raw);
    baseHash = snapshot.hash;
    text = baseText;
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
    const ta = textarea;
    if (!revealPending || !ta || loading) return;
    const lines = text.split('\n');
    const index = Math.min(Math.max(revealPending, 1), lines.length) - 1;
    revealPending = 0;
    const start = lines.slice(0, index).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[index]?.length ?? 0));
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, index * lineHeight - ta.clientHeight / 3);
  }

  // A line asked for before the text was in is shown once it is.
  $effect(() => {
    if (loading || !textarea) return;
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
      // The view now stands on the bytes it wrote. A later read can't be the
      // base: it may already hold a change another view queued meanwhile (a
      // Task List tick, a tag), which the next save would then wipe unseen.
      baseHash = result.hash;
      baseText = sent;
      const after = await noteStore.readRaw(path);
      if (!after || after.hash === result.hash) {
        // The file shows as the view does (BOM and line ending aside).
        if (after && text === sent) baseText = text = rawTextForView(after.raw);
        return 'saved';
      }
      // Something landed on top of this save.
      if (text === sent) {
        // Nothing typed since: follow it.
        baseHash = after.hash;
        baseText = text = rawTextForView(after.raw);
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
      textarea?.scrollIntoView({ block: 'nearest' });
      textarea?.focus();
    },
  };
  const unregister = registerRawView(handle);

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
  });

  onDestroy(() => {
    destroyed = true;
    unregister();
    // The teardown save below tracks its own write from here.
    setPending(false);
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
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
      bind:this={textarea}
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
