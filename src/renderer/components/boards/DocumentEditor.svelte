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
  import { documentStore } from '../../stores/document.svelte';
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
  import {
    loadMarkdownIntoEditor,
    editorMarkdown,
  } from '../../lib/editor/markdownSync';
  import {
    markHydrated,
    isHydrated,
    readMarkdownForHydrate,
    scheduleMarkdownWrite as gatewayScheduleMarkdownWrite,
    flushMarkdownWrite,
    registerForceWriter,
    unregisterForceWriter,
    type WriteArgs,
  } from '../../lib/vault/markdownFileWriter';
  import { reportError } from '../../lib/utils/errorBus';
  import { IpcEnvelopeError } from '@shared/ipcEnvelope';
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
  let docState = $derived(notePath ? documentStore.getDocument(notePath) : undefined);

  // BoardRouter intentionally skips boardStore loading for document tabs
  // (DocumentEditor reads from documentStore, not boardStore). The per-board
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
  let isUpdatingFromStore = false;
  let lastLoadedBody: string | null = null;
  // Same role as TextTile.backingFileMissing — set on ENOENT so subsequent
  // debounced writes don't re-create a file the user just deleted on disk.
  let backingFileMissing = false;
  // Hydration gate. Mirrored locally; the gateway enforces
  // the invariant on the write side via markHydrated.
  let hydrated = false;
  let callerId = '';
  // Set when the on-mount disk hydrate read FAILS (Windows
  // file lock / OneDrive / antivirus). While true the editor is held read-only
  // and `buildWriteArgs` refuses to write, so a keystroke into the
  // unexpectedly-blank editor can't truncate the real (unread) file. A banner
  // offers a retry; a later successful read clears the flag and resumes editing.
  let hydrateReadFailed = $state(false);
  // Reactive IME-composition flag (see onMount / reload effect).
  let isComposing = $state(false);

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
   * live cache; the gateway's writeMarkdownFile handles the
   * stale-cache re-read internally.
   */
  function buildWriteArgs(): WriteArgs | null {
    if (!editor || !docState || backingFileMissing || !hydrated) return null;
    // The on-mount disk read failed and we have no real body
    // loaded, so the editor is blank for reasons unrelated to the file's
    // content. Never write that emptiness over the file we couldn't read; a
    // successful retry (clears `hydrateReadFailed`) resumes writes.
    if (hydrateReadFailed && !lastLoadedBody) return null;
    if (documentStore.isReadOnly(docState.filename)) return null;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return null;
    const fm = documentStore.getFrontmatter(docState.filename) ?? {};
    return {
      vaultRoot,
      relPath: docState.filename,
      frontmatter: fm,
      body: editorMarkdown(editor),
      callerId,
      notePath: docState.filename,
    };
  }

  function scheduleMarkdownWrite(): void {
    const args = buildWriteArgs();
    if (!args) return;
    gatewayScheduleMarkdownWrite(args);
  }

  async function flushPendingMarkdownWrite(): Promise<void> {
    if (!callerId) return;
    // `flushMarkdownWrite` never rejects (failures resolve as `{ ok: false }`),
    // so branch on the result — markClean only on success.
    const result = await flushMarkdownWrite(callerId);
    if (result.ok) {
      if (docState && !backingFileMissing) documentStore.markClean(docState.filename, callerId);
      return;
    }
    const err = result.error;
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT' && docState) {
      backingFileMissing = true;
      reportError(
        'DocumentEditor',
        null,
        `"${docState.filename}" no longer exists on disk. Further edits won't be saved until the file is restored.`,
      );
      return;
    }
    // Generic failure — keep the doc dirty so the next flush attempt retries.
    // No reportError here: the gateway already surfaced the failure through
    // trackComponentWrite's save-error pipeline (toast + sentinel), so a
    // second toast would double-report.
    if (docState) documentStore.markDirty(docState.filename, callerId);
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
        // While the disk read failed the editor is frozen; ignore a
        // programmatic edit so it can't set `lastLoadedBody` (below) and defeat
        // buildWriteArgs' `hydrateReadFailed && !lastLoadedBody` refusal.
        if (hydrateReadFailed) return;
        const md = editorMarkdown(editor);
        // Record our OWN body so the reload `$effect` treats it as a no-op once
        // the gateway markCleans this writer. Without it every autosave would
        // reload the editor's own content (wiping redo, breaking IME composition).
        lastLoadedBody = md;
        if (notePath) {
          documentStore.updateContent(notePath, html, md, callerId);
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

    // Bridge prosemirror's composition state into a reactive
    // flag so the reload `$effect` defers mid-composition.
    // Anchored on the editor DOM, so editor.destroy() removes them.
    const composeEl = editor.view.dom;
    composeEl.addEventListener('compositionstart', () => { isComposing = true; });
    composeEl.addEventListener('compositionend', () => { isComposing = false; });

    callerId = `document-editor:${notePath}`;
    void hydrateFromDisk();
    registerForceWriter(callerId, notePath, buildWriteArgs);
  });

  // Loads the document body from the in-memory store when available, falling
  // back to a fresh disk read. Without the disk fallback, opening a document
  // via "Expand to Document" before its text tile had mounted (LOD block mode
  // or a just-loaded board) would leave the editor empty and any keystroke
  // would overwrite the .md file's real content.
  async function hydrateFromDisk() {
    if (!editor) return;
    try {
      // Only adopt the in-memory (body-only) body as a hydrate
      // source when this doc's frontmatter is already seeded (a sibling view,
      // e.g. the backing TextTile, read it from disk). Re-parsing FM from the
      // body-only store body yields {}, and seeding that would clobber the real
      // cached FM → a later body-only save erases the file's frontmatter block.
      // When unseeded, fall through to the authoritative disk read below.
      if (docState?.body && documentStore.hasFrontmatter(docState.filename)) {
        // Load the body-only store body VERBATIM. Re-parsing it would strip a
        // leading `---…---` rule pair as frontmatter and the first keystroke
        // would save the truncated body.
        lastLoadedBody = docState.body;
        isUpdatingFromStore = true;
        const result = loadMarkdownIntoEditor(editor, docState.body);
        documentStore.setReadOnly(docState.filename, result.lossy);
        isUpdatingFromStore = false;
        // `docState.body` is body-only, so a BOM sniff of it is always false;
        // marking unconditionally would clobber the hadBom a sibling view read
        // from disk and drop the file's BOM on the next save. Inherit the
        // existing fileState entry; only mark false as a fresh fallback.
        // The body does keep its line endings, so sniff CRLF from it — without
        // an `eol` a single-line-FM CRLF file would emit LF fences on the first
        // write. Pin only CRLF; leave LF/unknown to write-time detection.
        if (docState.filename && !isHydrated(docState.filename)) {
          const adoptEol = docState.body.includes('\r\n') ? '\r\n' : undefined;
          markHydrated(docState.filename, false, undefined, undefined, adoptEol);
        }
        return;
      }

      const vaultRoot = vaultStore.path;
      if (!vaultRoot || !docState?.filename) return;

      try {
        let body = '';
        let frontmatter: Record<string, unknown> = {};
        let rawFrontmatter = '';
        let readOk = false;
        try {
          // The read gateway seeds the hydrate gate + drift baseline from
          // the same read's mtime, so a later debounced write detects an
          // external edit landing after this hydrate.
          const hydrateResult = await readMarkdownForHydrate(vaultRoot, docState.filename);
          body = hydrateResult.body;
          frontmatter = hydrateResult.frontmatter;
          rawFrontmatter = hydrateResult.rawFrontmatter;
          readOk = true;
        } catch {
          // The read FAILED (Windows lock / OneDrive / AV). Do
          // NOT mount a blank, writable editor over a file we couldn't read: a
          // keystroke would truncate the real content on the next debounced
          // write. Flag the failure (buildWriteArgs refuses to write), hold the
          // editor read-only, and surface a retry banner. Still mark hydrated
          // (no disk mtime → no baseline) so the write-side invariant holds once
          // a retry succeeds.
          markHydrated(docState.filename, false);
          hydrateReadFailed = true;
        }
        if (!editor || editor.isDestroyed) return;
        if (!readOk) {
          // Keep the editor empty + non-editable; the banner's Retry re-runs
          // hydrateFromDisk. We deliberately skip the loadMarkdownIntoEditor +
          // applyReloadFromDisk below so the unread file's content isn't
          // replaced in-memory by an empty body. `finally` still sets `hydrated`.
          setEditorEditable(editor, false);
          return;
        }
        // Read succeeded — clear any prior failed state and re-enable editing
        // (the retry path lands here once the file becomes readable again).
        if (hydrateReadFailed) {
          hydrateReadFailed = false;
          setEditorEditable(editor, true);
        }
        lastLoadedBody = body;
        isUpdatingFromStore = true;
        const loadResult = loadMarkdownIntoEditor(editor, body);
        documentStore.setReadOnly(docState.filename, loadResult.lossy);
        isUpdatingFromStore = false;
        // Mirror the loaded body into the document store so other views (a sibling
        // TextTile on the canvas) reuse the same content without re-reading disk.
        // Pass the parsed body (without frontmatter) to match TextTile's load convention,
        // and seed the live frontmatter cache (+ the verbatim bytes) so the next
        // writer doesn't revert it and a body-only save preserves its formatting.
        documentStore.applyReloadFromDisk(docState.filename, body, [], frontmatter, rawFrontmatter);
      } catch (err) {
        console.warn('[DocumentEditor] Failed to read markdown file:', err);
      }
    } finally {
      // Flip hydrate true even on failure paths so writes
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
    // race with TipTap destroy. The callerId binding is stable, and a rename
    // carries the force-writer's registered path along with the note.
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
    // Gate on THIS view's own writer, not the shared isDirty, so a
    // clean DocumentEditor still reloads a sibling TextTile's latest body
    // instead of diverging and clobbering it on the next debounce flush.
    if (documentStore.isWriterDirty(docState.filename, callerId)) return;
    // Never reload mid-IME-composition; the effect re-runs on
    // compositionend and picks up whatever landed meanwhile.
    if (isComposing) return;
    // The live cache is refreshed elsewhere — applyReloadFromDisk on external
    // edits, or another writer's setFrontmatter on hydrate. The body is
    // body-only by contract: load it VERBATIM (no re-parse).
    lastLoadedBody = body;
    isUpdatingFromStore = true;
    const result = loadMarkdownIntoEditor(editor, body ?? '', { preserveSelection: true });
    documentStore.setReadOnly(docState.filename, result.lossy);
    isUpdatingFromStore = false;
  });

  // Read-only state for the banner.
  let readOnly = $derived(docState ? documentStore.isReadOnly(docState.filename) : false);
  // A note whose bytes aren't UTF-8 is non-editable until converted.
  let nonUtf8 = $derived(isNonUtf8(docState?.filename));

  // Freeze the editor while a tab-close drain is in flight so a keystroke
  // typed during the drain / failed-drain confirm can't re-arm a debounce the
  // unmount would then destroy. We never re-enable while a read failed (that
  // path holds it non-editable for its own reason). A lossy note is truly
  // non-editable (else typed text is silently discarded); Take ownership clears it.
  $effect(() => {
    const frozen = closeDrainGate.draining || readOnly || nonUtf8;
    if (!hydrateReadFailed) {
      // Non-emitting + untracked: see setEditorEditable (avoids an effect loop).
      untrack(() => setEditorEditable(editor, !frozen));
    }
  });

  // Re-run the disk hydrate after a transient read failure
  // (file lock released, OneDrive synced, AV finished). On success
  // `hydrateFromDisk` clears `hydrateReadFailed` and re-enables editing.
  function retryHydrate(): void {
    void hydrateFromDisk();
  }

  function convertToUtf8(): void {
    const vaultRoot = vaultStore.path;
    if (vaultRoot && docState?.filename) confirmConvertToUtf8(vaultRoot, docState.filename);
  }

  function takeOwnership(): void {
    if (!docState) return;
    const cid = docState.filename;
    uiStore.openConfirm({
      title: 'Take ownership of this file?',
      body: "Filo will be able to edit and save this file, but formatting it can't preserve (for example hard-wrapped lines, callouts, wiki links, comments) will be rewritten or removed on the next save. Continue?",
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
      {#if hydrateReadFailed}
        <!-- Read failed; editing is paused so a keystroke can't
             truncate the real (unread) file. Retry re-reads disk. -->
        <div class="readonly-banner" role="alert">
          <span class="readonly-text">Filo couldn't read this file{docState?.filename ? ` ("${docState.filename}")` : ''}. Editing is paused so your changes can't overwrite it — retry once the file is readable.</span>
          <button class="readonly-action" onclick={retryHydrate}>Retry</button>
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
