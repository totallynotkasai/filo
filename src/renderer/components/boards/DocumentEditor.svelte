<script lang="ts">
  /**
   * DocumentEditor — full-page Tiptap rich text editor for a single .md
   * document. Reads/writes from the document store; the backing file lives
   * in the vault. Renders the per-board styling cascade + frontmatter tags
   * + vault-file drop ergonomics that the old V2 DocumentBoard provided,
   * but persists via the disk-backed document store.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { noteStore, type NoteModel } from '../../stores/notes.svelte';
  import { NoteEditorView } from '../../lib/editor/noteEditorView';
  import { createId } from '../../lib/utils/ids';
  import { vaultStore } from '../../stores/vault.svelte';
  import { isNonUtf8 } from '../../lib/vault/nonUtf8Paths.svelte';
  import { confirmConvertToUtf8 } from '../../lib/vault/convertToUtf8';
  import { uiStore } from '../../stores/ui.svelte';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { setEditorEditable } from '../../lib/editor/setEditorEditable';
  import { reportError } from '../../lib/utils/errorBus';
  import { effectiveDocumentStyle } from '../../lib/styles/effectiveStyle';
  import { vaultRelativeFromAbsolute } from '../../lib/canvas/vaultPath';
  import { portal } from '../../lib/utils/portal';
  import { getAnchorBelow } from '../../lib/utils/popupAnchor';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import TagBadge from '../tags/TagBadge.svelte';
  import TagEditor from '../tags/TagEditor.svelte';
  import TagsPopupMenu from '../tags/TagsPopupMenu.svelte';
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

  // ── Frontmatter tags strip ──
  //
  // A Document board edits a `.md` file. Its frontmatter `tags:` list is
  // canonical, but the editor doesn't surface those tags anywhere — surface
  // a chip strip above the editor backed by `fileTagsStore.tagsForFile`
  // (the note's frontmatter); the file-path mode of TagEditor adds/removes
  // tags in that frontmatter.
  let documentTags = $derived.by<string[]>(() => {
    const path = docPath;
    if (!path) return [];
    return fileTagsStore.tagsForFile(path);
  });

  let tagEditorPopup = $state<{ x: number; y: number } | null>(null);
  let tagPopup = $state<{ tagName: string; x: number; y: number } | null>(null);

  function openDocumentTagEditor(e: MouseEvent) {
    e.stopPropagation();
    tagEditorPopup = getAnchorBelow(e.currentTarget as HTMLElement);
  }

  function handleTagClick(tagName: string, e: MouseEvent) {
    e.stopPropagation();
    if (tagPopup?.tagName === tagName) {
      tagPopup = null;
    } else {
      tagPopup = { tagName, x: e.clientX, y: e.clientY };
    }
  }
  function closeTagPopup() { tagPopup = null; }

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
          tiptapToolbar.setActiveEditor(editor);
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

    tiptapToolbar.setActiveEditor(editor);

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
      tiptapToolbar.clearActiveEditor();
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
  // The read failed for a reason other than a missing file: typing would
  // overwrite the unread file with an empty editor.
  let unreadable = $derived(model?.status === 'unreadable');
  let missing = $derived(model?.status === 'missing');

  // Freeze the editor while a tab-close drain is in flight (a keystroke would
  // be stranded by the unmount), while the note can't be written (lossy, not
  // UTF-8, unreadable, missing) and until it has loaded.
  $effect(() => {
    const status = model?.status;
    const frozen =
      closeDrainGate.draining || readOnly || nonUtf8 || unreadable || missing || status === 'loading';
    // Non-emitting + untracked: see setEditorEditable (avoids an effect loop).
    untrack(() => setEditorEditable(editor, !frozen));
  });

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
    bgColor={settings.backgroundColor}
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
      {#if nonUtf8}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">This note isn't UTF-8 (probably Windows-1252). Filo won't save it, to avoid corrupting characters.</span>
          <button class="readonly-action" onclick={convertToUtf8}>Convert to UTF-8…</button>
        </div>
      {:else if readOnly}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">Filo can't save this file without changing formatting it doesn't support, so it's open read-only.</span>
          <button class="readonly-action" onclick={takeOwnership}>Take ownership</button>
        </div>
      {/if}
      {#if docPath}
        <div class="document-tags-bar" aria-label="Document tags">
          {#each documentTags as name (name)}
            <TagBadge tagName={name} size="sm" onClick={(e) => handleTagClick(name, e)} />
          {/each}
          <button
            type="button"
            class="document-tags-edit"
            onclick={openDocumentTagEditor}
            title={documentTags.length > 0 ? 'Edit tags' : 'Add tags'}
            aria-label={documentTags.length > 0 ? 'Edit document tags' : 'Add document tags'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
              <line x1="7" y1="7" x2="7.01" y2="7"/>
              {#if documentTags.length === 0}
                <line x1="14" y1="11" x2="20" y2="11" stroke-width="2.5"/>
                <line x1="17" y1="8" x2="17" y2="14" stroke-width="2.5"/>
              {/if}
            </svg>
            {#if documentTags.length === 0}<span>Add tags</span>{/if}
          </button>
        </div>
      {/if}
      <div class="document-editor" bind:this={editorElement}></div>
    </div>
  </div>
</div>

{#if tagEditorPopup && docPath}
  <div
    class="document-tag-popup-overlay"
    role="presentation"
    onclick={() => tagEditorPopup = null}
    onkeydown={(e) => { if (e.key === 'Escape') tagEditorPopup = null; }}
  ></div>
  <div class="document-tag-popup-anchor" style="position: fixed; left: {tagEditorPopup.x}px; top: {tagEditorPopup.y}px;">
    <TagEditor filePath={docPath} onClose={() => tagEditorPopup = null} />
  </div>
{/if}

{#if tagPopup}
  <div
    use:portal
    class="tag-popup-overlay"
    onclick={closeTagPopup}
    onkeydown={(e) => { if (e.key === 'Escape') closeTagPopup(); }}
    role="presentation"
  ></div>
  <div
    use:portal
    class="tag-popup-anchor"
    style="position: fixed; left: {tagPopup.x}px; top: {tagPopup.y}px; z-index: var(--z-tile-popup);"
  >
    <TagsPopupMenu tagName={tagPopup.tagName} onClose={closeTagPopup} />
  </div>
{/if}

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

  .document-tags-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tag-row-gap);
    margin-bottom: 16px;
  }

  .document-tags-edit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    background: transparent;
    border: 1px dashed var(--ui-border);
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 11px;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }
  .document-tags-edit:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    border-color: var(--text-tertiary);
  }

  .document-tag-popup-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-tile-popup-overlay);
  }
  .document-tag-popup-anchor {
    z-index: var(--z-tile-popup);
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
    line-height: 1.75;
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

  .document-editor :global(.tiptap h1) {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 0.6em;
    margin-top: 1.2em;
    color: var(--text-primary);
  }

  .document-editor :global(.tiptap h2) {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 0.5em;
    margin-top: 1em;
    color: var(--text-primary);
  }

  .document-editor :global(.tiptap h3) {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 0.4em;
    margin-top: 0.8em;
    color: var(--text-primary);
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
