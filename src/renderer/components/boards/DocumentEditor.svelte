<script lang="ts">
  /**
   * DocumentEditor — full-page Tiptap rich text editor for a single .md
   * document. Reads/writes from the document store; the backing file lives
   * in the vault. Renders the per-board styling cascade + frontmatter tags
   * + vault-file drop ergonomics that the old V2 DocumentBoard provided,
   * but persists via the disk-backed document store.
   */
  import { onMount, onDestroy } from 'svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { documentStore } from '../../stores/document.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import {
    parseMarkdownFile,
    loadMarkdownIntoEditor,
    editorMarkdown,
  } from '../../lib/editor/markdownSync';
  import {
    markHydrated,
    readMarkdownForHydrate,
    scheduleMarkdownWrite as gatewayScheduleMarkdownWrite,
    flushMarkdownWrite,
    registerForceWriter,
    unregisterForceWriter,
    type WriteArgs,
  } from '../../lib/vault/markdownFileWriter';
  import { reportError } from '../../lib/utils/errorBus';
  import { IpcEnvelopeError } from '@shared/ipcEnvelope';
  import { createId } from '../../lib/utils/ids';
  import { effectiveDocumentStyle } from '../../lib/styles/effectiveStyle';
  import { vaultRelativeFromAbsolute } from '../../lib/canvas/vaultPath';
  import { portal } from '../../lib/utils/portal';
  import { getAnchorBelow } from '../../lib/utils/popupAnchor';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import TagBadge from '../tags/TagBadge.svelte';
  import TagEditor from '../tags/TagEditor.svelte';
  import TagsPopupMenu from '../tags/TagsPopupMenu.svelte';
  import type { BoardType } from '../../../shared/types';
  import type { DocumentBoard } from '../../schema/index';
  import type { Editor } from '@tiptap/core';

  let activeTab = $derived(tabStore.activeTab);
  let docId = $derived(activeTab?.boardId ?? '');
  let docState = $derived(docId ? documentStore.getDocument(docId) : undefined);

  // BoardRouter intentionally skips boardStore loading for document tabs
  // (DocumentEditor reads from documentStore, not boardStore). The per-board
  // styling cascade still needs the Board record, so we look it up from the
  // board cache directly — docId == boardId for Document boards.
  let board = $derived(
    docId ? (boardCacheStore.cache[docId]?.board as DocumentBoard | undefined) : undefined,
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
  let isUpdatingFromStore = false;
  let lastLoadedBody: string | null = null;
  // Same role as TextTile.backingFileMissing — set on ENOENT so subsequent
  // debounced writes don't re-create a file the user just deleted on disk.
  let backingFileMissing = false;
  // Phase 31 B1.4 — hydration gate. Mirrored locally; the gateway enforces
  // the invariant on the write side via markHydrated.
  let hydrated = false;
  let callerId = '';

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
      const title = (payload.name ?? '').replace(/\.(md|markdown)$/i, '');
      const existing = documentStore.findByFilename(relPath);
      let newDocId: string;
      if (existing) {
        newDocId = existing.docId;
      } else {
        newDocId = createId();
        documentStore.loadDocument({
          docId: newDocId,
          filename: relPath,
          title,
          body: '',
          htmlContent: '',
          richText: [],
        });
      }
      documentStore.openDocumentTab(newDocId);
      tabStore.open(newDocId, title, 'document' as BoardType);
    } catch (err) {
      reportError('DocumentEditor.drop', err, 'Failed to open the dropped file');
    }
  }

  // ── Frontmatter tags strip ──
  //
  // A Document board edits a `.md` file. Its frontmatter `tags:` list is
  // canonical, but the editor doesn't surface those tags anywhere — surface
  // a chip strip above the editor backed by `fileTagsStore.tagsForFile`;
  // the file-path mode of TagEditor handles add/remove with the proper
  // three-sink writes (frontmatter + .filo/tags.json + tile-defs).
  let documentTags = $derived.by<string[]>(() => {
    const path = docState?.filename;
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

  /**
   * Builds WriteArgs for the gateway. Returns null when the editor isn't
   * writable yet (no editor, no doc, no vault, hydrate pending, read-only,
   * or backing file missing). Sync — captures FM from the documentStore
   * live cache; the gateway's writeMarkdownFile handles the Phase 18 H13
   * stale-cache re-read internally.
   */
  function buildWriteArgs(): WriteArgs | null {
    if (!editor || !docState || backingFileMissing || !hydrated) return null;
    if (documentStore.isReadOnly(docState.docId)) return null;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return null;
    const fm = documentStore.getFrontmatter(docState.docId) ?? {};
    return {
      vaultRoot,
      relPath: docState.filename,
      frontmatter: fm,
      body: editorMarkdown(editor),
      callerId,
      docId: docState.docId,
    };
  }

  function scheduleMarkdownWrite(): void {
    const args = buildWriteArgs();
    if (!args) return;
    gatewayScheduleMarkdownWrite(args);
  }

  async function flushPendingMarkdownWrite(): Promise<void> {
    if (!callerId) return;
    try {
      await flushMarkdownWrite(callerId);
      if (docState && !backingFileMissing) documentStore.markClean(docState.docId);
    } catch (err) {
      if (err instanceof IpcEnvelopeError && err.code === 'ENOENT' && docState) {
        backingFileMissing = true;
        reportError(
          'DocumentEditor',
          null,
          `"${docState.filename}" no longer exists on disk. Further edits won't be saved until the file is restored.`,
        );
        return;
      }
      reportError('DocumentEditor', err, 'Failed to write markdown');
      if (docState) documentStore.markDirty(docState.docId);
    }
  }

  onMount(() => {
    if (!editorElement) return;

    editor = createTiptapEditor({
      element: editorElement,
      content: '',
      placeholder: '',
      editable: true,
      onUpdate: (html) => {
        if (isUpdatingFromStore) return;
        if (!editor) return;
        const md = editorMarkdown(editor);
        if (docId) {
          documentStore.updateContent(docId, html, md);
        }
        scheduleMarkdownWrite();
      },
      onFocus: () => {
        if (editor) {
          tiptapToolbar.setActiveEditor(editor);
        }
      },
      onBlur: () => {
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

    callerId = `document-editor:${docId}`;
    void hydrateFromDisk();
    registerForceWriter(callerId, docId, buildWriteArgs);
  });

  // Loads the document body from the in-memory store when available, falling
  // back to a fresh disk read. Without the disk fallback, opening a document
  // via "Expand to Document" before its text tile had mounted (LOD block mode
  // or a just-loaded board) would leave the editor empty and any keystroke
  // would overwrite the .md file's real content.
  async function hydrateFromDisk() {
    if (!editor) return;
    try {
      if (docState?.body) {
        const parsed = parseMarkdownFile(docState.body);
        documentStore.setFrontmatter(docState.docId, parsed.frontmatter);
        lastLoadedBody = docState.body;
        isUpdatingFromStore = true;
        const result = loadMarkdownIntoEditor(editor, parsed.body);
        documentStore.setReadOnly(docState.docId, result.lossy);
        isUpdatingFromStore = false;
        if (docState.filename) markHydrated(docState.filename, parsed.hadBom);
        return;
      }

      const vaultRoot = vaultStore.path;
      if (!vaultRoot || !docState?.filename) return;

      try {
        let body = '';
        let frontmatter: Record<string, unknown> = {};
        try {
          // E1 — read gateway seeds the hydrate gate + drift baseline from
          // the same read's mtime, so a later debounced write detects an
          // external edit landing after this hydrate.
          const hydrateResult = await readMarkdownForHydrate(vaultRoot, docState.filename);
          body = hydrateResult.body;
          frontmatter = hydrateResult.frontmatter;
        } catch {
          // Read failed — mount cleanly with empty content. Mark the file
          // hydrated (no disk mtime → no baseline) so subsequent keystroke
          // writes can proceed against the embedded fallback.
          markHydrated(docState.filename, false);
        }
        if (!editor || editor.isDestroyed) return;
        lastLoadedBody = body;
        isUpdatingFromStore = true;
        const loadResult = loadMarkdownIntoEditor(editor, body);
        documentStore.setReadOnly(docState.docId, loadResult.lossy);
        isUpdatingFromStore = false;
        // Mirror the loaded body into the document store so other views (a sibling
        // TextTile on the canvas) reuse the same content without re-reading disk.
        // Pass the parsed body (without frontmatter) to match TextTile's load convention,
        // and seed the live frontmatter cache so the next writer doesn't revert it.
        documentStore.applyReloadFromDisk(docState.docId, body, [], frontmatter);
      } catch (err) {
        console.warn('[DocumentEditor] Failed to read markdown file:', err);
      }
    } finally {
      // Phase 31 B1.4 — flip hydrate true even on failure paths so writes
      // can proceed against the embedded fallback. Without this, every
      // subsequent keystroke's schedule would no-op and the user's edits
      // would be silently dropped.
      hydrated = true;
    }
  }

  onDestroy(() => {
    // Drain the gateway's pending write BEFORE unregistering the force-writer
    // so a concurrent flushAllMarkdownWrites() snapshot still includes this
    // writer. Editor teardown is chained off the flush promise so the
    // synchronous editorMarkdown() capture inside writeMarkdownFile doesn't
    // race with TipTap destroy. The callerId binding is stable; docId is
    // reactive but the force-writer's docId field was captured at
    // registration time, which suffices for matching.
    const id = callerId;
    void flushPendingMarkdownWrite().finally(() => {
      if (id) unregisterForceWriter(id);
      if (editor) {
        tiptapToolbar.clearActiveEditor();
        editor.destroy();
        editor = null;
      }
    });
  });

  // Reload editor content when the underlying disk body changes (external edit
  // resolved via documentStore.applyReloadFromDisk). We compare against the
  // last body we loaded so user-driven edits don't trigger a reload loop.
  // `preserveSelection` keeps the caret in place when an external edit
  // replaces the body underneath an open editor.
  $effect(() => {
    if (!editor || !docState) return;
    const body = docState.body;
    if (body === lastLoadedBody) return;
    if (docState.isDirty) return;
    // The live cache is refreshed elsewhere — applyReloadFromDisk on external
    // edits, or another writer's setFrontmatter on hydrate. Strip any leading
    // frontmatter defensively in case body carries it.
    const parsed = parseMarkdownFile(body ?? '');
    lastLoadedBody = body;
    isUpdatingFromStore = true;
    const result = loadMarkdownIntoEditor(editor, parsed.body, { preserveSelection: true });
    documentStore.setReadOnly(docState.docId, result.lossy);
    isUpdatingFromStore = false;
  });

  // Phase 27 / A4 — read-only state for the banner.
  let readOnly = $derived(docState ? documentStore.isReadOnly(docState.docId) : false);

  function takeOwnership(): void {
    if (!docState) return;
    const cid = docState.docId;
    uiStore.openConfirm({
      title: 'Take ownership of this file?',
      body: 'Filo will overwrite the file with what its editor can read. Syntax it cannot preserve (callouts, math blocks, highlights, etc.) will be lost. Continue?',
      confirmLabel: 'Take ownership',
      cancelLabel: 'Cancel',
      danger: true,
      onConfirm: () => documentStore.takeOwnership(cid),
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
      {#if readOnly}
        <div class="readonly-banner" role="status">
          <span class="readonly-text">Filo couldn't preserve some syntax in this file. Saving is disabled.</span>
          <button class="readonly-action" onclick={takeOwnership}>Take ownership</button>
        </div>
      {/if}
      {#if docState?.filename}
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

{#if tagEditorPopup && docState?.filename}
  <div
    class="document-tag-popup-overlay"
    role="presentation"
    onclick={() => tagEditorPopup = null}
    onkeydown={(e) => { if (e.key === 'Escape') tagEditorPopup = null; }}
  ></div>
  <div class="document-tag-popup-anchor" style="position: fixed; left: {tagEditorPopup.x}px; top: {tagEditorPopup.y}px;">
    <TagEditor filePath={docState.filename} onClose={() => tagEditorPopup = null} />
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

  /* Phase 27 / A4 — lossy-round-trip read-only banner. Non-dismissable. */
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
  /* Phase A.3 — visible blank-line gap between consecutive paragraphs.
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
