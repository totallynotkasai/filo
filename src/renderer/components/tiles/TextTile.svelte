<script lang="ts">
  import type { TextTile } from '../../schema/index';
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { setEditorEditable } from '../../lib/editor/setEditorEditable';
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
    hasPendingMarkdownWriteFor,
    type WriteArgs,
  } from '../../lib/vault/markdownFileWriter';
  import { reportError } from '../../lib/utils/errorBus';
  import { isNonUtf8 } from '../../lib/vault/nonUtf8Paths.svelte';
  import { confirmConvertToUtf8 } from '../../lib/vault/convertToUtf8';
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
  // skip the IPC so we don't resurrect the file. The external-change prompt
  // flow lets the user reload or re-create.
  let backingFileMissing = false;
  // Hydration gate is enforced inside the gateway. This local flag (for the
  // "skip write before hydrate" check) flips true once `hydrateFromDisk`
  // resolves and `markHydrated` runs.
  let hydrated = false;
  // Set when the on-mount disk read fails with a NON-ENOENT error (FILE_TOO_LARGE,
  // or a transient EACCES/EBUSY from AV / OneDrive). While true the editor is
  // non-writable and `buildWriteArgs` refuses to write, so a keystroke into the
  // blank tile can't overwrite the real (unread) file with the stale board-JSON
  // seed. ENOENT stays on the embedded-fallback path. A successful retry clears it.
  let hydrateReadFailed = $state(false);
  // `tile.id` is reactive in Svelte 5; reading it inside `$derived` captures
  // the live value so a tile-id rebind (rare but possible during cache
  // mutation) re-keys the caller without re-mounting the component.
  let callerId = $derived(`text-tile:${tile.id}`);
  // Reactive IME-composition flag mirrored from the editor's composition
  // events. `editor.view.composing` is set by prosemirror but not reactive
  // on its own, so the reactive-reload effect needs this signal to know when
  // to re-run after the user commits their IME input.
  let isComposing = $state(false);
  // Set on the first real user edit (after the isUpdatingFromStore skip).
  // onDestroy writes only when this view actually changed something.
  let userEdited = false;

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
   * Synchronous — captures FM from the documentStore live cache. The
   * stale-cache re-read lives inside the gateway's `writeMarkdownFile` so every
   * write path benefits from it without each call site re-implementing it.
   */
  function buildWriteArgs(): WriteArgs | null {
    if (!editor || backingFileMissing || !hydrated) return null;
    // The on-mount disk read failed and no real body is loaded, so the editor
    // is blank for reasons unrelated to the file. Never write that emptiness /
    // the stale embedded seed over the file we couldn't read.
    if (hydrateReadFailed && !lastLoadedBody) return null;
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

  // No per-keystroke flush here: `onUpdate` arms the debounced gateway write,
  // the gateway (`writeMarkdownFileImpl`) owns the markClean on success, and
  // `onDestroy` drops this tile's writer via `documentStore.dropDirtyWriter`.

  onMount(() => {
    const ed: Editor = createTiptapEditor({
      element: editorElement,
      content: '',
      onUpdate: () => {
        if (isUpdatingFromStore) return;
        // While the disk read failed the editor is frozen; a
        // programmatic edit (toolbar command) must neither reach the store nor
        // set `lastLoadedBody`, which would defeat buildWriteArgs'
        // `hydrateReadFailed && !lastLoadedBody` refusal and write over the
        // unread file.
        if (hydrateReadFailed) return;
        userEdited = true;
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

        // `documentStore.updateContent` above is the canonical body sync (the
        // DocumentEditor's reactive `$effect` on `docState.body` picks it up).

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

    // Bridge prosemirror's composition state into a
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
   * Applies the lossy-round-trip flag from a load result.
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
    // Wrap the whole body so every early-return path
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
      // The docId this hydrate targets. Adoption rebinds the
      // tile to a sibling's docId; the `tile` prop may not have re-derived yet,
      // so thread the id locally instead of re-reading `tile.contentId`.
      let docId: string | undefined = tile.contentId;
      if (relPath) {
        const existing = documentStore.findByFilename(relPath);
        if (existing && existing.docId !== tile.contentId) {
          boardStore.updateTile(tile.id, { contentId: existing.docId });
          docId = existing.docId;
          // Re-register the force-writer with the adopted docId so Keep-local
          // matches against the new identity.
          registerForceWriter(callerId, existing.docId, buildWriteArgs);
          // Adopt the sibling's BODY only when the sibling really read disk: FM
          // seeded AND a non-empty body. A placeholder DocumentState (body '')
          // must never load into a writable editor — fall through to the
          // authoritative disk read.
          if (existing.body && documentStore.hasFrontmatter(existing.docId)) {
            // Do NOT re-seed frontmatter from `existing.body`: the cache the
            // sibling seeded from disk is authoritative. Load the body-only body
            // VERBATIM (no re-parse).
            const body = existing.body;
            lastLoadedBody = body;
            isUpdatingFromStore = true;
            applyLoadResult(loadMarkdownIntoEditor(editor, body), existing.docId);
            isUpdatingFromStore = false;
            // Inherit the sibling's hadBom from the existing `fileState` entry
            // (the body-only body carries no BOM); fall back to false when the
            // sibling hasn't hydrated. The body does keep its line endings, so
            // sniff CRLF from it — otherwise a single-line-CRLF FM file would
            // emit LF fences on the first write. Pin only CRLF; leave LF/unknown
            // to write-time detection so we never force a wrong LF.
            if (!isHydrated(relPath)) {
              const adoptEol = body.includes('\r\n') ? '\r\n' : undefined;
              markHydrated(relPath, false, undefined, undefined, adoptEol);
            }
            return;
          }
        }
      }

      const docState = docId ? documentStore.getDocument(docId) : null;
      // Only adopt the in-memory (body-only) body as a hydrate
      // source when this doc's frontmatter is already seeded (a sibling view
      // read it from disk). Re-parsing FM from the body-only store body yields
      // {}, and seeding that would clobber the real cached FM → a later
      // body-only save erases the file's frontmatter block. When unseeded,
      // fall through to the authoritative disk read below, which seeds FM
      // correctly (and never erases).
      if (docState?.body && docId && documentStore.hasFrontmatter(docId)) {
        // Load the store body VERBATIM. It is body-only by contract; re-parsing
        // would strip a leading `---…---` horizontal-rule pair as "frontmatter".
        const body = docState.body;
        lastLoadedBody = body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, body), docId);
        isUpdatingFromStore = false;
        // The body-only field carries no BOM. Inherit the existing `fileState`
        // entry's hadBom when it exists; only mark with false as a fresh
        // fallback. Sniff CRLF from the body so an adopt of a single-line-CRLF
        // FM file doesn't emit LF fences on the first write.
        if (relPath && !isHydrated(relPath)) {
          const adoptEol = body.includes('\r\n') ? '\r\n' : undefined;
          markHydrated(relPath, false, undefined, undefined, adoptEol);
        }
        return;
      }

      if (!vaultRoot || !relPath) {
        const seed = (tile.content as string) ?? '';
        const parsed = parseMarkdownFile(seed);
        if (docId) documentStore.setFrontmatter(docId, parsed.frontmatter);
        lastLoadedBody = parsed.body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body), docId);
        isUpdatingFromStore = false;
        if (relPath) markHydrated(relPath, parsed.hadBom);
        return;
      }

      try {
        // The read gateway seeds the hydrate gate + drift baseline from
        // the same read's mtime, so a later debounced write detects an
        // external edit that lands after this hydrate.
        const { body, frontmatter, rawFrontmatter } = await readMarkdownForHydrate(vaultRoot, relPath);
        // A retry that succeeds lands here: clear the failed-read flag and
        // re-enable editing (the close-drain $effect re-runs on the reactive
        // flag, but flip it directly too so a non-frozen tile resumes immediately).
        if (hydrateReadFailed) {
          hydrateReadFailed = false;
          setEditorEditable(editor, true);
        }
        // Seed the verbatim frontmatter bytes so a later body-only save
        // emits them untouched (comments / key order / line endings preserved).
        if (docId) documentStore.setFrontmatter(docId, frontmatter, rawFrontmatter);
        lastLoadedBody = body;
        isUpdatingFromStore = true;
        applyLoadResult(loadMarkdownIntoEditor(editor, body), docId);
        isUpdatingFromStore = false;
        if (docId) {
          documentStore.loadDocument({
            docId,
            filename: relPath,
            title: tile.title || 'Untitled',
            body,
            htmlContent: editor.getHTML(),
            richText: [],
          });
          // loadDocument is a no-op for an EXISTING entry, so an
          // unhydrated placeholder (body '') would keep '' while the editor shows
          // the disk body — and a later reactive reload would load '' back in.
          // Upgrade the placeholder to what we actually read.
          documentStore.adoptDiskBodyIfPlaceholder(docId, body, editor.getHTML());
        }
        return;
      } catch (err) {
        // A genuinely-missing backing file (ENOENT) is an expected, already-
        // surfaced state: `boardRefIntegrity` flags the placement with a
        // "backing file missing" badge on load, and the embedded-content
        // fallback below is the designed behaviour. Genuine, unexpected read
        // failures (permissions, decode errors, a directory in the path) warn.
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
          // The on-load / tree-refresh recomputes normally set the
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
          // A NON-ENOENT failure is NOT a missing file: the bytes exist but
          // couldn't be read (FILE_TOO_LARGE, transient EACCES/EBUSY). Falling
          // through to the embedded seed would let the next keystroke silently
          // write the stale creation-time seed over the real file. Instead flag
          // the failure (buildWriteArgs refuses to write), hold the editor
          // non-writable, and skip the seed. A retry re-reads disk.
          console.warn('[TextTile] Failed to read markdown file; holding non-writable until retry:', err);
          hydrateReadFailed = true;
          if (relPath) markHydrated(relPath, false);
          setEditorEditable(editor, false);
          return;
        }
      }

      // No backing file (legacy tile or fresh tile) — fall back to embedded
      // content. Reached only on the ENOENT path; the non-ENOENT failure
      // branch returns above so a stale seed never lands over an unread file.
      const seed = (tile.content as string) ?? '';
      const parsed = parseMarkdownFile(seed);
      if (docId) documentStore.setFrontmatter(docId, parsed.frontmatter);
      lastLoadedBody = parsed.body;
      isUpdatingFromStore = true;
      applyLoadResult(loadMarkdownIntoEditor(editor, parsed.body), docId);
      isUpdatingFromStore = false;
      if (relPath) markHydrated(relPath, parsed.hadBom);
    } finally {
      hydrated = true;
    }
  }

  // Reactive reload — when another view (a sibling text tile or a document
  // editor) writes to the same docId, documentStore.body changes. We watch it
  // and refresh this tile's editor to keep the views in sync. Gated on
  // THIS view's own writer dirtiness so we don't reload mid-typing of OUR
  // editor, yet a still-clean view DOES pick up a sibling's edits immediately
  // (keying on the shared `isDirty` would freeze every view once any became
  // dirty, and the last debounce flush would drop the other's keystrokes).
  // Gated on `lastLoadedBody` so we don't echo our own writes.
  $effect(() => {
    if (!editor) return;
    const docState = tile.contentId ? documentStore.getDocument(tile.contentId) : undefined;
    if (!docState) return;
    const body = docState.body;
    if (body === lastLoadedBody) return;
    if (tile.contentId && documentStore.isWriterDirty(tile.contentId, callerId)) return;
    // Skip the reload while the user is mid-IME-composition
    // (CJK / dead-key flows). ProseMirror's `setContent` mid-composition
    // both interrupts the composition window AND can produce a broken
    // commit (the composing text disappears as the new doc lands). The
    // reactive `isComposing` flag (driven by compositionstart/end on the
    // editor DOM) lets the effect re-run automatically when typing
    // settles, picking up any sibling-writer body that landed in the
    // meantime.
    if (isComposing) return;
    // `docState.body` is body-only by contract; load it VERBATIM (a re-parse
    // would strip a leading `---…---` rule pair as frontmatter). The live FM cache is
    // refreshed elsewhere (applyReloadFromDisk on external edits, or the
    // sibling writer's own setFrontmatter on hydrate); we don't re-seed it
    // here. `preserveSelection` keeps the caret in place when an external
    // edit replaces the body underneath an open editor.
    lastLoadedBody = body ?? '';
    isUpdatingFromStore = true;
    applyLoadResult(loadMarkdownIntoEditor(editor, body ?? '', { preserveSelection: true }));
    isUpdatingFromStore = false;
  });

  onDestroy(() => {
    // Capture contentId synchronously up front: `tile.contentId` is reactive
    // and could rebind during teardown; the dirty-writer drop and the final
    // write must both target the id this tile actually held.
    const contentId = tile.contentId;
    const relPath = vaultRelativePath();

    // Capture the latest write args SYNCHRONOUSLY from the live editor, then
    // destroy the editor, then dispatch the IPC — so the TipTap instance isn't
    // pinned alive for the duration of the disk write.
    //
    // Only when this writer has unsaved work: unmounts are routine (viewport
    // culling, LOD switch, board/tab switch), and an unconditional final write
    // would re-serialise every untouched note through the editor (`_x_` →
    // `*x*`, mixed EOLs). A failed earlier write keeps the writer dirty (the
    // gateway markCleans only on success), so destroy still retries it.
    const hasUnsaved =
      userEdited &&
      (!contentId || documentStore.isWriterDirty(contentId, callerId) || hasPendingMarkdownWriteFor(callerId));
    const finalArgs = hasUnsaved ? buildWriteArgs() : null;
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

    // Drop THIS tile's dirty-writer entry even though the final write below is
    // fire-and-forget. Unconditional: once unmounted no editor holds unsaved
    // content, so a lingering writerId would pin `DocumentState.isDirty` true —
    // routing a later external edit to a spurious Reload prompt and freezing a
    // sibling's reload `$effect`.
    if (contentId) documentStore.dropDirtyWriter(contentId, callerId);

    if (finalArgs) {
      // flushFinalWriteOnDestroy no-ops if the gateway was already
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
   * Read-only state surfaced for the banner. Reactive via
   * documentStore.isReadOnly which reads the SvelteSet under a version tick.
   */
  let readOnly = $derived(tile.contentId ? documentStore.isReadOnly(tile.contentId) : false);
  // A note whose bytes aren't UTF-8 is non-editable (a save would persist
  // U+FFFD for every non-ASCII byte) until converted.
  let nonUtf8 = $derived(isNonUtf8(vaultRelativePath()));

  // Freeze the editor while a tab-close drain is in flight (a keystroke would
  // re-arm a debounce the unmount destroys), and while the note is lossy
  // read-only (otherwise typed text is silently discarded). `readOnly` is
  // reactive, so Take ownership re-enables editing automatically. Never
  // re-enable while a hydrate read failed — that path holds the editor
  // non-writable so a keystroke can't overwrite the unread file.
  $effect(() => {
    const frozen = closeDrainGate.draining || readOnly || nonUtf8;
    if (!hydrateReadFailed) {
      // Non-emitting + untracked: see setEditorEditable (avoids an effect loop).
      untrack(() => setEditorEditable(editor, !frozen));
    }
  });

  // Re-run the disk hydrate after a transient read failure (file lock released,
  // OneDrive synced, AV finished). On success `hydrateFromDisk` clears
  // `hydrateReadFailed` and re-enables editing.
  function retryHydrate(): void {
    void hydrateFromDisk();
  }

  function convertToUtf8(): void {
    const vaultRoot = vaultStore.path;
    const relPath = vaultRelativePath();
    if (vaultRoot && relPath) confirmConvertToUtf8(vaultRoot, relPath);
  }

  function takeOwnership(): void {
    if (!tile.contentId) return;
    const cid = tile.contentId;
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

<div class="text-tile">
  {#if hydrateReadFailed}
    <!-- Read failed; editing is paused so a keystroke can't
         overwrite the real (unread) file with the embedded seed. Retry re-reads disk. -->
    <div class="readonly-banner" role="alert">
      <span class="readonly-text">Filo couldn't read this file. Editing is paused so your changes can't overwrite it — retry once the file is readable.</span>
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

  /* Lossy-round-trip read-only banner. Non-dismissable so
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
