<script lang="ts">
  import type { TextTile } from '../../schema/index';
  import { onMount, onDestroy } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import {
    parseMarkdownFile,
    loadMarkdownIntoEditor,
    editorMarkdown,
  } from '../../lib/editor/markdownSync';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { boardRefIntegrityStore } from '../../stores/boardRefIntegrity.svelte';
  import { documentStore } from '../../stores/document.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import type { ResolvedTileStyle } from '../../lib/styles/effectiveStyle';
  import {
    RESOLVED_TILE_STYLE_KEY,
    type ResolvedTileStyleHolder,
  } from '../../lib/styles/resolvedTileStyleContext';
  import {
    markHydrated,
    isHydrated,
    readMarkdownForHydrate,
    scheduleMarkdownWrite as gatewayScheduleMarkdownWrite,
    registerForceWriter,
    unregisterForceWriter,
    flushFinalWriteOnDestroy,
    cancelMarkdownWrite,
    type WriteArgs,
  } from '../../lib/vault/markdownFileWriter';
  import { reportError } from '../../lib/utils/errorBus';
  import { IpcEnvelopeError } from '@shared/ipcEnvelope';
  let {
    tile,
    resolved: resolvedOverride,
  }: {
    tile: TextTile;
    /** Pre-resolved style. <KanbanCard> passes its composed style so the
     *  card cascade's per-card `fontSizeBody` override reaches the body
     *  without TextTile re-running the cascade. */
    resolved?: ResolvedTileStyle;
  } = $props();

  // Resolved style: explicit prop (Kanban card cascade) wins; otherwise read
  // from the context TileContainer set after walking the cascade.
  const styleHolder = getContext<ResolvedTileStyleHolder | undefined>(RESOLVED_TILE_STYLE_KEY);
  let bodyFontStyle = $derived.by(() => {
    const fs = (resolvedOverride ?? styleHolder?.value)?.fontSizeBody;
    return fs != null ? `font-size: ${fs}px;` : '';
  });

  let editorElement: HTMLElement;
  let editor: Editor | null = null;
  let isUpdatingFromStore = false;
  let lastLoadedBody: string | null = null;
  // Set to `true` once the IPC reports the backing file no longer exists
  // (deleted externally during a dirty edit). Subsequent debounced writes
  // skip the IPC so we don't resurrect the file. Phase 2 owns the prompt-
  // user flow that lets the user reload or re-create.
  let backingFileMissing = false;
  // Phase 31 B1.4 — hydration gate enforced inside the gateway. The local
  // flag (mirrored here for the legacy "skip write before hydrate" check)
  // flips true once `hydrateFromDisk` resolves and `markHydrated` runs.
  let hydrated = false;
  // `tile.id` is reactive in Svelte 5; reading it inside `$derived` captures
  // the live value so a tile-id rebind (rare but possible during cache
  // mutation) re-keys the caller without re-mounting the component.
  let callerId = $derived(`text-tile:${tile.id}`);
  // Sprint B / B21 — reactive IME-composition flag mirrored from the
  // editor's composition events. `editor.view.composing` is set by
  // prosemirror but not reactive on its own, so the reactive-reload
  // effect needs this signal to know when to re-run after the user
  // commits their IME input.
  let isComposing = $state(false);

  function vaultRelativePath(): string | null {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return null;
    // Priority order:
    //   1. Explicit `filePath` on the tile def — set by fileRefIntegrity when
    //      the backing .md moves out of its board-type convention folder.
    //      Persisted, so it survives restarts.
    //   2. Live DocumentState filename — in-memory canonical for the docId;
    //      kept in sync by vaultStore.rename's updateFilename hook.
    //   3. Convention fallback — `${title}.md` at the convention folder,
    //      used only before hydrate has loaded a DocumentState.
    const explicit = (tile as { filePath?: string }).filePath;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const docState = tile.contentId ? documentStore.getDocument(tile.contentId) : null;
    return docState?.filename || `${tile.title || 'Untitled'}.md`;
  }

  /**
   * Builds the WriteArgs snapshot the gateway needs from the current editor
   * state. Returns null when the tile isn't writable yet (no editor mounted,
   * no vault, no relPath, or hydrate hasn't completed). Shared between the
   * schedule path (onUpdate) and the force-write path (Keep-local).
   *
   * Synchronous — captures FM from the documentStore live cache. The Phase 18 H13
   * stale-cache re-read lives inside the gateway's `writeMarkdownFile` so every
   * write path benefits from it without each call site re-implementing it.
   */
  function buildWriteArgs(): WriteArgs | null {
    if (!editor || backingFileMissing || !hydrated) return null;
    if (tile.contentId && documentStore.isReadOnly(tile.contentId)) return null;
    const vaultRoot = vaultStore.path;
    const relPath = vaultRelativePath();
    if (!vaultRoot || !relPath) return null;
    const fm: Record<string, unknown> = (tile.contentId && documentStore.getFrontmatter(tile.contentId)) || {};
    return {
      vaultRoot,
      relPath,
      frontmatter: fm,
      body: editorMarkdown(editor),
      callerId,
      docId: tile.contentId ?? null,
    };
  }

  function scheduleMarkdownWrite(): void {
    const args = buildWriteArgs();
    if (!args) return;
    gatewayScheduleMarkdownWrite(args);
  }

  // Audit-7 M1 — the former `flushPendingMarkdownWrite` (a dead, never-called
  // copy of DocumentEditor's) was deleted. The successful-write markClean now
  // lives in the gateway (`writeMarkdownFileImpl`), which covers BOTH editor
  // views in one place; `onDestroy` drops this tile's writer via
  // `documentStore.dropDirtyWriter`. There is no remaining per-keystroke flush
  // here — `onUpdate` arms the debounced gateway write and the gateway owns the
  // clean transition.

  onMount(() => {
    const ed: Editor = createTiptapEditor({
      element: editorElement,
      content: '',
      onUpdate: () => {
        if (isUpdatingFromStore) return;
        const md = editorMarkdown(ed);
        const html = ed.getHTML();
        // Track our own write so the reactive $effect below treats it as a
        // no-op (otherwise the editor would reload itself on every keystroke
        // and the cursor selection would be destroyed).
        lastLoadedBody = md;
        boardStore.updateTile(tile.id, { content: html });

        if (tile.contentId) {
          documentStore.updateContent(tile.contentId, html, md, callerId);
        }

        // L2 (Audit-12) — the former write into the in-memory virtual
        // `project.boards[*].content` was deleted. `documentStore.updateContent`
        // above is the canonical body sync (the DocumentEditor's reactive
        // `$effect` on `docState.body` picks it up); the virtual project is
        // in-memory only and nothing reads `.content` as a write source (the
        // `.md` write sources from the editor markdown), so the mutation was
        // vestigial — it bypassed reactivity and synced nothing.

        scheduleMarkdownWrite();
      },
      onFocus: () => {
        tiptapToolbar.setActiveEditor(ed);
      },
      onBlur: () => {
        if (tiptapToolbar.activeEditor === ed) {
          tiptapToolbar.clearActiveEditor();
        }
      },
      onSelectionUpdate: () => {
        tiptapToolbar.syncState();
      },
      onTransaction: () => {
        tiptapToolbar.syncState();
      }
    });
    editor = ed;

    // Sprint B / B21 — bridge prosemirror's composition state into a
    // reactive flag so the reload `$effect` can defer mid-composition.
    // Bound to the contenteditable DOM (editor.view.dom) so events bubble
    // up cleanly regardless of selection state. Removed by editor.destroy()
    // since the listener is anchored on its DOM.
    const composeEl = ed.view.dom;
    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => { isComposing = false; };
    composeEl.addEventListener('compositionstart', onCompositionStart);
    composeEl.addEventListener('compositionend', onCompositionEnd);

    void hydrateFromDisk();
    // Register a fresh-args build callback so `forceWriteForDocument`
    // (Keep-local in vaultExternalChanges) can flush THIS tile's live editor
    // body even when no schedule is armed. The docId binding is dynamic —
    // hydrateFromDisk may rebind tile.contentId to adopt a sibling view's
    // docId — but the registerForceWriter call captures docId statically at
    // call time. To keep matching working post-adoption, re-register inside
    // hydrateFromDisk on adoption (see below).
    registerForceWriter(callerId, tile.contentId ?? null, buildWriteArgs);
  });

  /**
   * Phase 27 / A4 — applies the lossy-round-trip flag from a load result.
   * `targetDocId` defaults to the tile's current contentId; pass an
   * `existing.docId` explicitly when adopting a sibling view's docId so the
   * read-only state lands on the right document.
   */
  function applyLoadResult(result: { lossy: boolean }, targetDocId: string | undefined = tile.contentId): void {
    if (!targetDocId) return;
    documentStore.setReadOnly(targetDocId, result.lossy);
  }

  async function hydrateFromDisk() {
    if (!editor) return;
    // Phase 31 B1.4 — wrap the whole body so every early-return path
    // (sibling-docId adoption, cached body, missing-vault fallback, IPC
    // read failure, embedded-seed fallback) ends with `hydrated = true`.
    // Without the try/finally the failure paths could leave a stale
    // `false` and silently lock writes for the lifetime of the tile.
    try {
      const vaultRoot = vaultStore.path;
      const relPath = vaultRelativePath();

      // If another view (text tile / document editor) is already holding the
      // same .md file under a different docId, adopt its docId so the stores
      // collapse to a single DocumentState. Without this, two tiles for the
      // same file get keyed independently and never share edits.
      if (relPath) {
        const existing = documentStore.findByFilename(relPath);
        if (existing && existing.docId !== tile.contentId) {
          boardStore.updateTile(tile.id, { contentId: existing.docId });
          const parsed = parseMarkdownFile(existing.body ?? '');
          // audit2 2.2 — do NOT re-seed frontmatter from `existing.body`: the
          // store body is body-only by contract, so parseMarkdownFile yields
          // {}, and seeding that would clobber the real FM the view that first
          // opened `existing` already seeded from disk (a later body-only save
          // would then erase the file's frontmatter block). The cache is
          // authoritative once seeded; leave it untouched.
          lastLoadedBody = parsed.body;
          isUpdatingFromStore = true;
          applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body), existing.docId);
          isUpdatingFromStore = false;
          // Phase 6.1.R5 — inherit the sibling's hadBom from the existing
          // `fileState` entry; do NOT re-sniff from `parsed.hadBom`, which
          // is computed from the body-only `existing.body` (always false
          // because the body is stripped). When isHydrated is false the
          // sibling hadn't done its own disk read yet, so fall back to false.
          // L5 (Audit-12) — but the body retains its line endings (unlike the
          // BOM), so sniff CRLF from it: without an eol a single-line-CRLF FM
          // file would emit LF fences on the first gateway write (the A8-M1
          // hole on the adopt path). Pin only CRLF; leave LF/unknown to
          // write-time detection so we never force a wrong LF.
          if (!isHydrated(relPath)) {
            const adoptEol = parsed.body.includes('\r\n') ? '\r\n' : undefined;
            markHydrated(relPath, false, undefined, undefined, adoptEol);
          }
          // Re-register the force-writer with the adopted docId so Keep-local
          // matches against the new identity.
          registerForceWriter(callerId, existing.docId, buildWriteArgs);
          return;
        }
      }

      const docState = tile.contentId ? documentStore.getDocument(tile.contentId) : null;
      // audit2 2.2 — only adopt the in-memory (body-only) body as a hydrate
      // source when this doc's frontmatter is already seeded (a sibling view
      // read it from disk). Re-parsing FM from the body-only store body yields
      // {}, and seeding that would clobber the real cached FM → a later
      // body-only save erases the file's frontmatter block. When unseeded,
      // fall through to the authoritative disk read below, which seeds FM
      // correctly (and never erases).
      if (docState?.body && tile.contentId && documentStore.hasFrontmatter(tile.contentId)) {
        const parsed = parseMarkdownFile(docState.body);
        lastLoadedBody = parsed.body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body));
        isUpdatingFromStore = false;
        // Phase 6.1.R5 — `docState.body` is the body-only field, so
        // `parsed.hadBom` is always false (BOM was stripped before the
        // store cached the body). Inherit the existing `fileState`
        // entry's hadBom when it exists; only mark with false as a
        // fresh fallback for a doc that has no prior hydrate.
        // L5 (Audit-12) — sniff CRLF from the body-only body so an adopt of a
        // single-line-CRLF FM file doesn't emit LF fences on the first write.
        if (relPath && !isHydrated(relPath)) {
          const adoptEol = parsed.body.includes('\r\n') ? '\r\n' : undefined;
          markHydrated(relPath, false, undefined, undefined, adoptEol);
        }
        return;
      }

      if (!vaultRoot || !relPath) {
        const seed = (tile.content as string) ?? '';
        const parsed = parseMarkdownFile(seed);
        if (tile.contentId) documentStore.setFrontmatter(tile.contentId, parsed.frontmatter);
        lastLoadedBody = parsed.body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body));
        isUpdatingFromStore = false;
        if (relPath) markHydrated(relPath, parsed.hadBom);
        return;
      }

      try {
        // E1 — the read gateway seeds the hydrate gate + drift baseline from
        // the same read's mtime, so a later debounced write detects an
        // external edit that lands after this hydrate.
        const { body, frontmatter, rawFrontmatter } = await readMarkdownForHydrate(vaultRoot, relPath);
        // 1.2 — seed the verbatim frontmatter bytes so a later body-only save
        // emits them untouched (comments / key order / line endings preserved).
        if (tile.contentId) documentStore.setFrontmatter(tile.contentId, frontmatter, rawFrontmatter);
        lastLoadedBody = body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, body));
        isUpdatingFromStore = false;
        if (tile.contentId) {
          documentStore.loadDocument({
            docId: tile.contentId,
            filename: relPath,
            title: tile.title || 'Untitled',
            body,
            htmlContent: editor.getHTML(),
            richText: [],
          });
        }
        return;
      } catch (err) {
        // A genuinely-missing backing file (ENOENT) is an expected, already-
        // surfaced state: `boardRefIntegrity` flags the placement with a
        // "backing file missing" badge on load, and the embedded-content
        // fallback below is the designed behaviour. Genuine, unexpected read
        // failures (permissions, decode errors, a directory in the path) warn.
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
          // #16 — the on-load / tree-refresh recomputes normally set the
          // "backing file missing" badge, but a file deleted AFTER load (before
          // the tree caught up) can reach this re-hydrate with no badge yet. If
          // this tile isn't already flagged, recompute against the live tree so
          // the badge is immediate. The `isBrokenTile` guard keeps a board-open
          // pass over many already-flagged broken tiles from triggering a
          // recompute storm (the on-load recompute flagged them first).
          if (!boardRefIntegrityStore.isBrokenTile(tile.id)) {
            vaultStore.recomputeBrokenRefsNow();
          }
          // Debug breadcrumb rather than a full suppress — a silently-swallowed
          // ENOENT is invisible when diagnosing a vanished backing file. The
          // main process already skips its own stack trace for ENOENT reads.
          console.debug('[TextTile] backing markdown missing (ENOENT); using embedded fallback:', relPath);
        } else {
          console.warn('[TextTile] Failed to read markdown file, using legacy content:', err);
        }
      }

      // No backing file (legacy tile or fresh tile) — fall back to embedded content.
      const seed = (tile.content as string) ?? '';
      const parsed = parseMarkdownFile(seed);
      if (tile.contentId) documentStore.setFrontmatter(tile.contentId, parsed.frontmatter);
      lastLoadedBody = parsed.body;
      isUpdatingFromStore = true;
      applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body));
      isUpdatingFromStore = false;
      if (relPath) markHydrated(relPath, parsed.hadBom);
    } finally {
      hydrated = true;
    }
  }

  // Reactive reload — when another view (a sibling text tile or a document
  // editor) writes to the same docId, documentStore.body changes. We watch it
  // and refresh this tile's editor to keep the views in sync. Gated on
  // THIS view's own writer dirtiness (audit2 2.2) so we don't reload
  // mid-typing of OUR editor, yet a still-clean view DOES pick up a sibling's
  // edits immediately — keying on the shared `isDirty` instead froze every
  // view the moment any one became dirty, so two views editing the same file
  // diverged and the last debounce flush dropped the other's keystrokes.
  // Gated on `lastLoadedBody` so we don't echo our own writes.
  $effect(() => {
    if (!editor) return;
    const docState = tile.contentId ? documentStore.getDocument(tile.contentId) : undefined;
    if (!docState) return;
    const body = docState.body;
    if (body === lastLoadedBody) return;
    if (tile.contentId && documentStore.isWriterDirty(tile.contentId, callerId)) return;
    // Sprint B / B21 — skip the reload while the user is mid-IME-composition
    // (CJK / dead-key flows). ProseMirror's `setContent` mid-composition
    // both interrupts the composition window AND can produce a broken
    // commit (the composing text disappears as the new doc lands). The
    // reactive `isComposing` flag (driven by compositionstart/end on the
    // editor DOM) lets the effect re-run automatically when typing
    // settles, picking up any sibling-writer body that landed in the
    // meantime.
    if (isComposing) return;
    // Body may still carry frontmatter if a sibling writer round-tripped it
    // into documentStore.updateContent — strip defensively. The live cache
    // is refreshed elsewhere (applyReloadFromDisk on external edits, or the
    // sibling writer's own setFrontmatter on hydrate); we don't re-seed it
    // here. `preserveSelection` keeps the caret in place when an external
    // edit replaces the body underneath an open editor.
    const parsed = parseMarkdownFile(body ?? '');
    lastLoadedBody = parsed.body;
    isUpdatingFromStore = true;
    applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body, { preserveSelection: true }));
    isUpdatingFromStore = false;
  });

  onDestroy(() => {
    // Audit-7 M1 — capture contentId synchronously up front. `tile.contentId`
    // is reactive and could rebind during teardown; the dirty-writer drop and
    // the final-write args below must both target the id this tile actually
    // held, not a value that changed after an await.
    const contentId = tile.contentId;
    const relPath = vaultRelativePath();

    // Sprint B / B20 — capture the latest write args SYNCHRONOUSLY from the
    // live editor before destroying it, then destroy the editor, then
    // dispatch the IPC. The previous flow awaited the IPC roundtrip BEFORE
    // editor.destroy(), pinning the TipTap instance (and its prosemirror
    // doc + extensions + plugin state) alive for the full duration of the
    // disk write. With this re-ordering the editor is reclaimed
    // immediately; the IPC owns only the small `WriteArgs` snapshot.
    const finalArgs = buildWriteArgs();
    // Cancel any debounced timer for this caller so the snapshot we're
    // about to fire isn't shadowed by a slightly-older scheduled write
    // landing afterwards.
    if (finalArgs) cancelMarkdownWrite(callerId);

    if (editor) {
      if (tiptapToolbar.activeEditor === editor) {
        tiptapToolbar.clearActiveEditor();
      }
      editor.destroy();
      editor = null;
    }
    unregisterForceWriter(callerId);
    // Note: don't clearHydrated(relPath) here — sibling text tiles for the
    // same file may still be mounted (split-pane, multiple boards open),
    // and clearing it would force them to re-hydrate before writing. The
    // hydrate state is per-file, not per-tile; vault swap drops it via
    // cancelAllMarkdownWrites.
    void relPath;

    // Audit-7 M1 — drop THIS tile's dirty-writer entry even though the final
    // write below is fire-and-forget. Keyed by the captured contentId (safe
    // against a rebind) and unconditional: once the tile unmounts there is no
    // editor left to hold unsaved content, so a lingering writerId would pin
    // `DocumentState.isDirty` true with no live view able to clear it — routing
    // a later external edit on this file to a spurious Reload prompt and
    // freezing a sibling's reload `$effect`. DocumentEditor.onDestroy markCleans
    // symmetrically; TextTile used to leave the writer stranded (its
    // markClean lived in dead code).
    if (contentId) documentStore.dropDirtyWriter(contentId, callerId);

    if (finalArgs) {
      // 6.4.M17 — flushFinalWriteOnDestroy no-ops if the gateway was already
      // reset by a vault swap (cancelAllMarkdownWrites cleared the hydrate
      // state), so this teardown write respects the swap reset instead of
      // firing a stray write / throwing "not hydrated".
      void flushFinalWriteOnDestroy(finalArgs).catch((err) => {
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
          // Backing file vanished during the close gesture — surface the
          // same toast the live flush path would have produced.
          reportError(
            'TextTile',
            null,
            `${relPath ?? 'File'} no longer exists on disk. Final edits couldn't be saved.`,
          );
          return;
        }
        reportError('TextTile', err, 'Failed to write markdown on unmount');
      });
    }
  });

  /**
   * Phase 27 / A4 — read-only state surfaced for the banner. Reactive via
   * documentStore.isReadOnly which reads the SvelteSet under a version tick.
   */
  let readOnly = $derived(tile.contentId ? documentStore.isReadOnly(tile.contentId) : false);

  // Audit-17 5.7 — freeze the tile's editor while a tab-close drain is in flight
  // so a keystroke can't re-arm a debounce the unmount would destroy. Lossy
  // read-only disables SAVING (buildWriteArgs), not editing, so the only reason
  // to toggle TipTap editability here is the close drain.
  $effect(() => {
    const frozen = closeDrainGate.draining;
    if (editor && !editor.isDestroyed) {
      editor.setEditable(!frozen);
    }
  });

  function takeOwnership(): void {
    if (!tile.contentId) return;
    const cid = tile.contentId;
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

<div class="text-tile">
  {#if readOnly}
    <div class="readonly-banner" role="status">
      <span class="readonly-text">Filo couldn't preserve some syntax in this file. Saving is disabled.</span>
      <button class="readonly-action" onclick={takeOwnership}>Take ownership</button>
    </div>
  {/if}
  <div class="editor-container" style={bodyFontStyle} bind:this={editorElement}></div>
</div>

<style>
  .text-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .editor-container {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    outline: none;
    cursor: text;
    /* Text-tile body inherits the user's "Default Board Font Size > Tile Body"
       setting. Per-element overrides on the rendered marks (TipTap inline
       fontSize) still win — this only sets the editor's base size. */
    font-size: var(--font-size-tile-body, 13px);
    /* Standard scrollbar properties — disables global ::-webkit-scrollbar overrides */
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }

  /* Phase 27 / A4 — lossy-round-trip read-only banner. Non-dismissable so
     the user can't accidentally save through an unsupported file. */
  .readonly-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--ui-warn-bg, #fef3c7);
    border-bottom: 1px solid var(--ui-warn-border, #f59e0b);
    color: var(--ui-warn-text, #92400e);
    font-size: 12px;
    flex-shrink: 0;
  }

  .readonly-text {
    flex: 1;
  }

  .readonly-action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--ui-warn-border, #f59e0b);
    background: transparent;
    color: var(--ui-warn-text, #92400e);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .readonly-action:hover {
    background: var(--ui-warn-bg-hover, #fcd34d);
  }
</style>
