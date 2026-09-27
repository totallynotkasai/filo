<script lang="ts">
  /**
   * DocumentEditor — full-page Tiptap rich text editor for a single .md
   * note. Every view of the note shares its model in the note store; the
   * backing file lives in the vault. Renders the per-board styling cascade,
   * the note's tag row and vault-file drop handling.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { noteStore, type NoteModel } from '../../stores/notes.svelte';
  import { resolveLineSpacing } from '../../stores/noteMeta';
  import { NoteEditorView } from '../../lib/editor/noteEditorView';
  import { createId } from '../../lib/utils/ids';
  import { vaultStore } from '../../stores/vault.svelte';
  import { isLinkedNote, isNonUtf8 } from '../../lib/vault/nonUtf8Paths.svelte';
  import { confirmConvertToUtf8 } from '../../lib/vault/convertToUtf8';
  import { uiStore } from '../../stores/ui.svelte';
  import { trashStore } from '../../stores/trash.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { setEditorEditable } from '../../lib/editor/setEditorEditable';
  import { reportError } from '../../lib/utils/errorBus';
  import { effectiveDocumentStyle } from '../../lib/styles/effectiveStyle';
  import { vaultRelativeFromAbsolute } from '../../lib/canvas/vaultPath';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import NoteTagRow from '../tags/NoteTagRow.svelte';
  import NoteRawView from './NoteRawView.svelte';
  import type { DocumentBoard } from '../../schema/index';
  import type { Editor } from '@tiptap/core';

  // Pane-scoped, NOT global. BoardRouter renders this with the
  // pane's own `tabId` (and remounts via `{#key tab.id}` on a pane tab change), so
  // two panes showing different Document boards each bind to their OWN doc. Reading
  // `tabStore.activeTab` here would make both panes mirror the globally-active tab —
  // swapping content underneath and staling the captured callerId/force-writer.
  let { tabId }: { tabId: string } = $props();
  let tab = $derived(tabStore.tabs.find((t) => t.id === tabId));
  // The note this tab shows, by vault path; the rename cascade rewrites it
  // when the file moves (see tabs.svelte.ts).
  let notePath = $derived(tab?.notePath ?? '');

  // BoardRouter intentionally skips boardStore loading for document tabs
  // (DocumentEditor reads the note store, not boardStore). The per-board
  // styling cascade still needs the Board record, so we look it up from the
  // board cache by the tab's board id.
  let board = $derived(
    tab?.boardId ? (boardCacheStore.cache[tab.boardId]?.board as DocumentBoard | undefined) : undefined,
  );
  let settings = $derived(
    board?.settings ?? {
      backgroundColor: '',
      backgroundPattern: 'none' as const,
      accentColor: ACCENT_COLOR,
    },
  );

  // Route paper styling through the cascade so per-board overrides in
  // Current Board settings actually win over Global Defaults.
  let docStyle = $derived(
    effectiveDocumentStyle(vaultStore.project?.settings ?? null, board ?? null),
  );
  let paperInlineStyle = $derived.by(() => {
    const parts: string[] = [];
    if (docStyle.bodyColor) parts.push(`background-color: ${docStyle.bodyColor}`);
    if (docStyle.borderColor) parts.push(`border-color: ${docStyle.borderColor}`);
    parts.push(`border-style: ${docStyle.borderStyle}`);
    parts.push(`border-width: ${docStyle.borderWidth}px`);
    parts.push(
      `box-shadow: 0 2px ${10 * docStyle.shadowIntensity}px rgba(0,0,0,${0.3 * docStyle.shadowIntensity})`,
    );
    if (docStyle.bodyTextColor) parts.push(`color: ${docStyle.bodyTextColor}`);
    return parts.join('; ');
  });

  let editorElement: HTMLDivElement;
  let editor: Editor | null = null;
  // One view per mount; a split pane showing the same note is another view
  // of the same note model.
  const view = new NoteEditorView(`document-editor:${createId(8)}`, () => editor);
  // The model at the tab's path, whichever object it is (a rename can move
  // another one there).
  let model = $derived<NoteModel | null>(notePath ? (noteStore.get(notePath) ?? null) : null);
  // The note's path in its on-disk spelling, once acquired.
  let docPath = $derived(model?.relPath ?? '');
  // The note's line spacing: its own `lineSpacing:`, else the project default
  // (the same value a text tile of this note uses).
  let lineSpacing = $derived(resolveLineSpacing(docPath));
  // Reactive IME-composition flag (see onMount / the follow effect).
  let isComposing = $state(false);

  $effect(() => {
    const path = notePath;
    untrack(() => view.show(path));
  });

  // ── Vault-file drop ──
  //
  // Dropping a `.md` from the sidebar onto a Document board opens that file
  // in a new tab rather than replacing the current document — a Document
  // board is bound to one file at a time and silently swapping would lose
  // the user's scroll/cursor context. Other vault file types are rejected
  // with a toast.
  let dropActive = $state(false);

  function dragHasVaultFile(e: DragEvent): boolean {
    const t = e.dataTransfer?.types;
    if (!t) return false;
    return t.includes('application/x-vault-file') || t.includes('application/x-vault-files');
  }

  function handleDragOver(e: DragEvent) {
    if (!dragHasVaultFile(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropActive = true;
  }

  function handleDragLeave(e: DragEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement)?.contains(next)) return;
    dropActive = false;
  }

  function handleDrop(e: DragEvent) {
    dropActive = false;
    if (e.dataTransfer?.types.includes('application/x-vault-files')) {
      e.preventDefault();
      uiStore.toast('Drag one file at a time', 'info', 2500);
      return;
    }
    const raw = e.dataTransfer?.getData('application/x-vault-file');
    if (!raw) return;
    e.preventDefault();
    try {
      const payload = JSON.parse(raw) as { path: string; name?: string; extension?: string };
      const ext = (payload.extension ?? '').toLowerCase();
      if (ext !== '.md' && ext !== '.markdown') {
        uiStore.toast('Only markdown files can be opened as documents', 'info', 2500);
        return;
      }
      const vaultDir = vaultStore.path;
      if (!vaultDir) return;
      const relPath = vaultRelativeFromAbsolute(payload.path, vaultDir) || payload.path;
      openNoteInDocumentTab(relPath);
    } catch (err) {
      reportError('DocumentEditor.drop', err, 'Failed to open the dropped file');
    }
  }

  /** The note this tab shows, for whole-note toolbar settings (line spacing). */
  function activeNote(): { path: string; historyBoardId: string } | null {
    return docPath && tab?.boardId ? { path: docPath, historyBoardId: tab.boardId } : null;
  }

  onMount(() => {
    if (!editorElement) return;

    editor = createTiptapEditor({
      element: editorElement,
      content: '',
      placeholder: '',
      editable: true,
      onUpdate: () => {
        view.edited();
      },
      onFocus: () => {
        if (editor) {
          tiptapToolbar.setActiveEditor(editor, activeNote);
        }
      },
      onBlur: () => {
        // Another view may take over the note next; hand it every keystroke.
        view.serialize();
        tiptapToolbar.clearActiveEditor();
      },
      onSelectionUpdate: () => {
        tiptapToolbar.syncState();
      },
      onTransaction: () => {
        tiptapToolbar.syncState();
      },
    });

    tiptapToolbar.setActiveEditor(editor, activeNote);

    // Anchored on the editor DOM, so editor.destroy() removes them.
    const composeEl = editor.view.dom;
    composeEl.addEventListener('compositionstart', () => { isComposing = true; });
    composeEl.addEventListener('compositionend', () => { isComposing = false; });
    // The model may have loaded before the editor existed.
    untrack(() => view.sync({ composing: false }));
  });

  onDestroy(() => {
    // Unsaved keystrokes go to the model; the note writer saves them after
    // this view is gone.
    view.close();
    if (editor) {
      tiptapToolbar.releaseEditor(editor);
      editor.destroy();
      editor = null;
    }
  });

  // Follow the note: a body typed in another view (a split pane, a tile), a
  // change on disk or a reload loads here, keeping the caret where it was.
  // Never mid-composition; the effect re-runs on compositionend.
  $effect(() => {
    const m = model;
    if (!m) return;
    void m.bodyRevision;
    void m.status;
    const composing = isComposing;
    untrack(() => view.sync({ composing }));
  });

  let readOnly = $derived(model?.lossy ?? false);
  // A note whose bytes aren't UTF-8 is non-editable until converted.
  let nonUtf8 = $derived(isNonUtf8(docPath));
  // A symbolic link is shown but never written: saving would replace the link
  // with a regular file, and the original would stop getting the edits.
  let linked = $derived(isLinkedNote(docPath));
  // The read failed for a reason other than a missing file: typing would
  // overwrite the unread file with an empty editor.
  let unreadable = $derived(model?.status === 'unreadable');
  let missing = $derived(model?.status === 'missing');
  // A note deleted in Filo sits in its trash: find it, so the banner can offer
  // it back. Read again each time the note goes missing.
  $effect(() => {
    if (missing) untrack(() => void trashStore.refresh());
  });
  let trashed = $derived(missing && docPath ? trashStore.entryHolding(docPath) : undefined);

  // Freeze the editor while a tab-close drain is in flight (a keystroke would
  // be stranded by the unmount), while the note can't be written (lossy, not
  // UTF-8, a link, unreadable, missing) and until it has loaded.
  $effect(() => {
    const status = model?.status;
    const frozen =
      closeDrainGate.draining || readOnly || nonUtf8 || linked || unreadable || missing || status === 'loading';
    // Non-emitting + untracked: see setEditorEditable (avoids an effect loop).
    untrack(() => setEditorEditable(editor, !frozen));
  });

  // The raw view shows the whole file as text. The rich editor stays mounted
  // underneath (hidden) so it keeps following the note.
  let rawMode = $state(false);
  let rawView: NoteRawView | undefined = $state();

  async function toggleRaw(): Promise<void> {
    if (rawMode) {
      // Leave only once the typed text is on disk. On a conflict or a failed
      // write the view stays, with its banner, so the text stays in front of
      // the user instead of vanishing with the unmount.
      const result = rawView ? await rawView.save() : 'clean';
      if (result === 'clean' || result === 'saved') rawMode = false;
      return;
    }
    // Hand the model every keystroke, so the raw text includes them.
    view.serialize();
    rawMode = true;
  }

  function closeThisTab(): void {
    void tabStore.close(tabId);
  }

  function restoreFromTrash(): void {
    if (trashed) void trashStore.restore(trashed);
  }

  function retryRead(): void {
    if (docPath) void noteStore.reload(docPath);
  }

  function convertToUtf8(): void {
    const vaultRoot = vaultStore.path;
    if (vaultRoot && docPath) confirmConvertToUtf8(vaultRoot, docPath);
  }

  function takeOwnership(): void {
    if (!docPath) return;
    const path = docPath;
    uiStore.openConfirm({
      title: 'Take ownership of this file?',
      body: "Filo will be able to edit and save this file, but formatting it can't preserve (for example hard-wrapped lines, callouts, wiki links, comments) will be rewritten or removed on the next save. Continue?",
      confirmLabel: 'Take ownership',
      cancelLabel: 'Cancel',
      danger: true,
      onConfirm: () => noteStore.takeOwnership(path),
    });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="document-board"
  class:drop-active={dropActive}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <BoardBackground
    pattern={settings.backgroundPattern ?? vaultStore.project?.settings?.document?.backgroundPattern}
    bgColor={settings.backgroundColor || vaultStore.project?.settings?.document?.backgroundColor || ''}
  />
  <div class="document-container">
    <div class="document-paper" style={paperInlineStyle}>
      {#if unreadable}
        <!-- Read failed; editing is paused so a keystroke can't
             truncate the real (unread) file. Retry re-reads disk. -->
        <div class="readonly-banner" role="alert">
          <span class="readonly-text">Filo couldn't read this file{docPath ? ` ("${docPath}")` : ''}. Editing is paused so your changes can't overwrite it — retry once the file is readable.</span>
          <button class="readonly-action" onclick={retryRead}>Retry</button>
        </div>
      {/if}
      {#if missing}
        <!-- The file is gone, so there is nothing to edit or save into. -->
        <div class="readonly-banner missing-banner" role="alert">
          <span class="readonly-text">This note was deleted or moved.</span>
          {#if trashed}
            <button class="readonly-action" onclick={restoreFromTrash} disabled={trashStore.busy}>Restore from Trash</button>
          {/if}
          <button class="readonly-action" onclick={closeThisTab}>Close tab</button>
        </div>
      {/if}
      {#if nonUtf8}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">This note isn't UTF-8 (probably Windows-1252). Filo won't save it, to avoid corrupting characters.</span>
          <button class="readonly-action" onclick={convertToUtf8}>Convert to UTF-8…</button>
        </div>
      {:else if linked}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">This note is a link; edit the original.</span>
        </div>
      {:else if readOnly}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">Filo can't save this file without changing formatting it doesn't support, so it's open read-only.</span>
          <button class="readonly-action" onclick={takeOwnership}>Take ownership</button>
        </div>
      {/if}
      {#if docPath}
        <div class="document-header">
          <div class="document-tags-bar">
            {#if !rawMode}
              <NoteTagRow path={docPath} boardId={tab?.boardId ?? ''} readOnly={nonUtf8 || linked || unreadable || missing} />
            {/if}
          </div>
          <button
            type="button"
            class="raw-toggle"
            aria-pressed={rawMode}
            title={rawMode ? 'Back to the formatted view' : 'View raw Markdown'}
            aria-label={rawMode ? 'Back to the formatted view' : 'View raw Markdown'}
            disabled={unreadable || missing}
            onclick={() => void toggleRaw()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <span>{rawMode ? 'Formatted' : 'Raw'}</span>
          </button>
        </div>
      {/if}
      {#if rawMode && docPath}
        <NoteRawView bind:this={rawView} path={docPath} readOnly={nonUtf8 || linked} />
      {/if}
      <div
        class="document-editor"
        class:raw-hidden={rawMode}
        style:--note-line-height={lineSpacing}
        bind:this={editorElement}
      ></div>
    </div>
  </div>
</div>

<style>
  .document-board {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    position: relative;
    background: var(--canvas-bg, var(--ui-bg));
  }

  /* Vault-file drop cue. Matches MindMap's dashed-outline pattern. */
  .document-board.drop-active {
    outline: 2px dashed var(--accent-primary, #3a86ff);
    outline-offset: -2px;
    background: color-mix(in srgb, var(--accent-primary, #3a86ff) 4%, var(--canvas-bg, var(--ui-bg)));
  }

  .document-container {
    position: relative;
    z-index: 1;
    max-width: 860px;
    margin: 0 auto;
    padding: 48px 24px;
    min-height: 100%;
  }

  .document-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }

  .document-tags-bar {
    flex: 1;
    min-width: 0;
  }

  .raw-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    padding: 3px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 11px;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .raw-toggle:hover:not(:disabled),
  .raw-toggle[aria-pressed='true'] {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .raw-toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .document-editor.raw-hidden {
    display: none;
  }

  .document-paper {
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.06);
    min-height: calc(100vh - 180px);
    padding: 56px 72px;
  }

  .document-editor {
    min-height: 400px;
    outline: none;
  }

  /* Lossy-round-trip read-only banner. Non-dismissable. */
  .readonly-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: -56px -72px 24px;
    padding: 10px 16px;
    background: var(--ui-warn-bg, #fef3c7);
    border-bottom: 1px solid var(--ui-warn-border, #f59e0b);
    color: var(--ui-warn-text, #92400e);
    font-size: 13px;
  }

  .readonly-text {
    flex: 1;
  }

  .readonly-action {
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--ui-warn-border, #f59e0b);
    background: transparent;
    color: var(--ui-warn-text, #92400e);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .readonly-action:hover {
    background: var(--ui-warn-bg-hover, #fcd34d);
  }

  .document-editor :global(.tiptap) {
    outline: none;
    min-height: 400px;
    color: var(--text-primary);
    font-size: 16px;
    line-height: var(--note-line-height, 1.5);
    font-family: var(--font-system);
  }

  .document-editor :global(.tiptap p) {
    margin-top: 0;
    margin-bottom: 1.25em;
  }
  /* Visible blank-line gap between consecutive paragraphs.
     Adjacent-sibling rule beats CSS margin collapse so the second paragraph
     always gets the extra breathing room, matching Word-style
     "Enter = blank line between paragraphs." */
  .document-editor :global(.tiptap p + p) {
    margin-top: 0.5em;
  }

  /* Sizes and weights come from the shared `.tiptap h1…h6` scale in
     style.css (em, so on the 16px body here); a document only adds room
     around its headings. */
  .document-editor :global(.tiptap h1) {
    margin-bottom: 0.6em;
    margin-top: 1.2em;
  }

  .document-editor :global(.tiptap h2) {
    margin-bottom: 0.5em;
    margin-top: 1em;
  }

  .document-editor :global(.tiptap h3),
  .document-editor :global(.tiptap h4) {
    margin-bottom: 0.4em;
    margin-top: 0.8em;
  }

  .document-editor :global(.tiptap h5),
  .document-editor :global(.tiptap h6) {
    margin-bottom: 0.35em;
    margin-top: 0.7em;
  }

  .document-editor :global(.tiptap ul),
  .document-editor :global(.tiptap ol) {
    padding-left: 1.5em;
    margin-bottom: 0.8em;
  }

  .document-editor :global(.tiptap li) {
    margin-bottom: 0.3em;
  }

  .document-editor :global(.tiptap blockquote) {
    border-left: 3px solid var(--ui-border);
    padding-left: 1em;
    margin-left: 0;
    color: var(--text-secondary);
    font-style: italic;
  }

  .document-editor :global(.tiptap code) {
    background: var(--ui-surface-hover);
    padding: 0.15em 0.4em;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .document-editor :global(.tiptap pre) {
    background: var(--ui-bg);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin-bottom: 0.8em;
  }

  .document-editor :global(.tiptap pre code) {
    background: none;
    padding: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .document-editor :global(.tiptap table) {
    border-collapse: collapse;
    margin-bottom: 0.8em;
    width: 100%;
  }

  .document-editor :global(.tiptap th),
  .document-editor :global(.tiptap td) {
    border: 1px solid var(--ui-border);
    padding: 8px 12px;
    text-align: left;
  }

  .document-editor :global(.tiptap th) {
    background: var(--ui-surface-hover);
    font-weight: 600;
  }

  .document-editor :global(.tiptap a) {
    color: var(--accent-primary);
    text-decoration: underline;
  }

  .document-editor :global(.tiptap img) {
    max-width: 100%;
    border-radius: 4px;
  }

  .document-editor :global(.tiptap hr) {
    border: none;
    border-top: 1px solid var(--ui-border);
    margin: 1.5em 0;
  }

  .document-editor :global(.tiptap .is-empty::before) {
    content: attr(data-placeholder);
    color: var(--text-tertiary);
    pointer-events: none;
    float: left;
    height: 0;
  }

  .document-editor :global(.tiptap ul[data-type="taskList"]) {
    list-style: none;
    padding-left: 0;
  }

  .document-editor :global(.tiptap ul[data-type="taskList"] li) {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .document-editor :global(.tiptap ul[data-type="taskList"] li label) {
    margin-top: 3px;
  }
</style>
