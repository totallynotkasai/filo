<script lang="ts">
  import type { TextTile } from '../../schema/index';
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { createTiptapEditor } from '../../lib/editor/createEditor';
  import { closeDrainGate } from '../../lib/editor/closeDrainGate.svelte';
  import { setEditorEditable } from '../../lib/editor/setEditorEditable';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { NoteEditorView } from '../../lib/editor/noteEditorView';
  import { getContext } from 'svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardRefIntegrityStore } from '../../stores/boardRefIntegrity.svelte';
  import { noteStore, type NoteModel } from '../../stores/notes.svelte';
  import { resolveLineSpacing } from '../../stores/noteMeta';
  import { uiStore } from '../../stores/ui.svelte';
  import { createId } from '../../lib/utils/ids';
  import type { ResolvedTileStyle } from '../../lib/styles/effectiveStyle';
  import {
    RESOLVED_TILE_STYLE_KEY,
    type ResolvedTileStyleHolder,
  } from '../../lib/styles/resolvedTileStyleContext';
  import { isLinkedNote, isNonUtf8 } from '../../lib/vault/nonUtf8Paths.svelte';
  import { confirmConvertToUtf8 } from '../../lib/vault/convertToUtf8';
  let {
    tile,
    resolved: resolvedOverride,
    onEditorReady,
  }: {
    tile: TextTile;
    /** Pre-resolved style. <KanbanCard> passes its composed style so the
     *  card cascade's per-card `fontSizeBody` override reaches the body
     *  without TextTile re-running the cascade. */
    resolved?: ResolvedTileStyle;
    /** Called once, when the editor exists and the note has loaded into it
     *  (a lazily mounted card puts the caret where its preview was clicked). */
    onEditorReady?: (editor: Editor) => void;
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
  // One view per mount: two tiles of one note (or a tile and a Document tab)
  // are separate views of the same note model.
  const view = new NoteEditorView(`text-tile:${createId(8)}`, () => editor);
  // Reactive IME-composition flag; `editor.view.composing` isn't reactive, so
  // the reload effect below needs this to re-run once the user commits.
  let isComposing = $state(false);

  // The note this tile shows. `filePath` is its only identity; the rename
  // cascade rewrites it on the board when the file moves.
  let notePath = $derived(tile.filePath ?? '');
  // The model at that path, whichever object it is (a rename can move another
  // one there).
  let model = $derived<NoteModel | null>(notePath ? (noteStore.get(notePath) ?? null) : null);
  // The note's line spacing: its own `lineSpacing:`, else the project default, so
  // the tile and a Document tab of the same note always match.
  let lineSpacing = $derived(resolveLineSpacing(notePath));
  let editorStyle = $derived(`${bodyFontStyle}line-height: ${lineSpacing};`);

  $effect(() => {
    const path = notePath;
    untrack(() => view.show(path));
  });

  onMount(() => {
    const ed: Editor = createTiptapEditor({
      element: editorElement,
      content: '',
      onUpdate: () => {
        view.edited();
      },
      onFocus: () => {
        tiptapToolbar.setActiveEditor(ed, () => (notePath ? { path: notePath, historyBoardId: tile.boardId } : null));
      },
      onBlur: () => {
        // Another view may take over the note next; hand it every keystroke.
        view.serialize();
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

    // Anchored on the editor DOM, so editor.destroy() removes them.
    const composeEl = ed.view.dom;
    composeEl.addEventListener('compositionstart', () => { isComposing = true; });
    composeEl.addEventListener('compositionend', () => { isComposing = false; });
    // The model may have loaded before the editor existed.
    untrack(() => {
      view.sync({ composing: false });
      reportReady();
    });
  });

  let readyReported = false;
  function reportReady(): void {
    if (readyReported || !editor || !onEditorReady) return;
    const m = model;
    if (!m || m.status === 'loading') return;
    readyReported = true;
    onEditorReady(editor);
  }

  // Follow the note: a body typed in another view, a change on disk or a
  // reload loads here. Never mid-composition; the effect re-runs on
  // compositionend and picks up whatever landed meanwhile.
  $effect(() => {
    const m = model;
    if (!m) return;
    void m.bodyRevision;
    void m.status;
    const composing = isComposing;
    untrack(() => {
      view.sync({ composing });
      reportReady();
    });
  });

  // A file deleted after the board loaded may not carry its "missing" badge
  // yet; recompute against the live tree so it shows now.
  $effect(() => {
    if (model?.status !== 'missing') return;
    untrack(() => {
      if (!boardRefIntegrityStore.isBrokenTile(tile.id)) vaultStore.recomputeBrokenRefsNow();
    });
  });

  onDestroy(() => {
    // Unsaved keystrokes go to the model first; the note writer saves them
    // even though this view is gone.
    view.close();
    if (editor) {
      tiptapToolbar.releaseEditor(editor);
      editor.destroy();
      editor = null;
    }
  });

  let readOnly = $derived(model?.lossy ?? false);
  // A note whose bytes aren't UTF-8 is non-editable (a save would persist
  // U+FFFD for every non-ASCII byte) until converted.
  let nonUtf8 = $derived(isNonUtf8(notePath));
  // A symbolic link is shown but never written (saving would replace the link).
  let linked = $derived(isLinkedNote(notePath));
  // The read failed for a reason other than a missing file: nothing real is
  // loaded, so typing would overwrite the unread file with an empty editor.
  let unreadable = $derived(model?.status === 'unreadable');
  let missing = $derived(model?.status === 'missing');

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

  function retryRead(): void {
    if (notePath) void noteStore.reload(notePath);
  }

  function convertToUtf8(): void {
    const vaultRoot = vaultStore.path;
    if (vaultRoot && notePath) confirmConvertToUtf8(vaultRoot, notePath);
  }

  function takeOwnership(): void {
    if (!notePath) return;
    const path = notePath;
    uiStore.openConfirm({
      title: 'Take ownership of this file?',
      body: "Filo will be able to edit and save this file, but formatting it can't preserve (for example callouts, wiki links, comments) will be rewritten or removed on the next save. Continue?",
      confirmLabel: 'Take ownership',
      cancelLabel: 'Cancel',
      danger: true,
      onConfirm: () => noteStore.takeOwnership(path),
    });
  }
</script>

<div class="text-tile">
  {#if unreadable}
    <!-- Read failed; editing is paused so a keystroke can't
         overwrite the real (unread) file with an empty editor. Retry re-reads disk. -->
    <div class="readonly-banner" role="alert">
      <span class="readonly-text">Filo couldn't read this file. Editing is paused so your changes can't overwrite it — retry once the file is readable.</span>
      <button class="readonly-action" onclick={retryRead}>Retry</button>
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
  <div class="editor-container" style={editorStyle} bind:this={editorElement}></div>
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
