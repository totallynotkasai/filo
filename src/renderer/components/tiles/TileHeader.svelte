<script lang="ts">
  import StyleIcon from '../shared/StyleIcon.svelte';
  /**
   * TileHeader — header bar with title, tags, lock, style, expand, delete buttons.
   */
  import type { Tile, TextTile } from '../../schema/index';
  import type { ResolvedTileStyle } from '../../lib/styles/effectiveStyle';
  import type { Editor } from '@tiptap/core';
  import { getContext, untrack } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { normalizePath } from '../../lib/utils/path';
  import { effectiveTileStyle } from '../../lib/styles/effectiveStyle';
  import { createLabelEditor } from '../../lib/editor/createEditor';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { commitWhenLeft } from '../../lib/editor/titleEditFocus';
  import { sanitizeInlineHtml } from '../../lib/utils/sanitizeHtml';
  import { getAnchorBelow } from '../../lib/utils/popupAnchor';
  import { resolveTitleCommitValues, visibleTitleHtml, type ResolvedTitleCommit } from '../../lib/editor/titleCommit';
  import { historyStore } from '../../stores/history.svelte';
  import { registerComponentFlush } from '../../lib/boards/componentFlush';
  import { takeTitleEdit } from '../../lib/boards/newTileTitle';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { recreateMissingNote } from '../../lib/notes/recreateNote';
  import { reportError } from '../../lib/utils/errorBus';
  import { relinkTargets } from '../../lib/vault/relinkTargets';
  import { UpdateTitleCommand, ToggleFramelessCommand, textTileNotePaths } from '../../commands/index';
  import {
    PendingWritesFailedError,
    withDrainedWrites,
  } from '../../lib/vault/vaultOperations';

  // Per-pane scope. Aliases preserve call sites.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const selectionStore = scope.selection;

  let { tile, resolved }: { tile: Tile; resolved?: ResolvedTileStyle } = $props();

  // Whether this tile's backing vault file is missing. Drives the inline
  // red `!` badge rendered next to the title.
  let isBroken = $derived(boardStore.isBrokenTile(tile.id));

  // Fall back to a local resolution when the parent doesn't pass one in
  // (keeps stand-alone uses of TileHeader working).
  let effective = $derived(
    resolved ?? effectiveTileStyle(tile, vaultStore.project?.settings, boardStore.current)
  );

  // Header text colour comes from the cascade-resolved Dynamic Contrast
  // Text decision; null means "let CSS variables handle it".
  let headerTextColor = $derived(effective.headerTextColor);
  let headerBg = $derived(effective.headerColor || 'var(--tile-header-bg)');
  // Resolved title font-size override (or null → fall through to CSS).
  let titleFontStyle = $derived(
    effective.fontSizeTitle != null ? `font-size: ${effective.fontSizeTitle}px;` : '',
  );

  let isEditing = $state(false);
  let titleEditorElement = $state<HTMLDivElement | null>(null);
  let titleEditor: Editor | null = $state(null);

  // The rendered title falls back to plain text when no rich-text version
  // has been authored, or when the stored formatting no longer spells the
  // current title (it was changed elsewhere). titleHtml comes from the TipTap
  // inline editor; it is sanitized through DOMPurify before {@html} renders it
  // to defend against tampered board files.
  let visibleHtml = $derived(visibleTitleHtml(tile.titleHtml, tile.title));
  let titleDisplay = $derived(visibleHtml ? sanitizeInlineHtml(visibleHtml) : null);

  // Whether this text tile names a note in the vault.
  let hasVaultFile = $derived(
    tile.type === 'text' && !!(tile as TextTile).filePath
  );

  // Media tiles support the "frameless" (media-only) display toggle — hides
  // the header/border/background so just the media shows. Gated to media
  // types because the cascade + ImageTile transparent-letterbox treatment
  // only makes sense for them.
  let isMediaTile = $derived(
    tile.type === 'image' || tile.type === 'video'
    || tile.type === 'audio' || tile.type === 'file'
  );

  /**
   * The edit opened by itself on a tile just made: its title is only a
   * placeholder, so there is nothing for Escape to go back to, and Escape
   * keeps what was typed instead of dropping it.
   */
  let editingNewTile = false;

  function startEditing() {
    isEditing = true;
    // Editor mount happens in the $effect below once the host div binds.
  }

  // A tile the user just made opens with its title selected, so typing names it.
  $effect(() => {
    if (untrack(() => takeTitleEdit(tile.id))) {
      editingNewTile = true;
      startEditing();
    }
  });

  function destroyTitleEditor() {
    if (titleEditor) {
      tiptapToolbar.releaseEditor(titleEditor);
      titleEditor.destroy();
      titleEditor = null;
    }
  }

  /**
   * Snapshot the live editor's value as resolved commit inputs. Must be read
   * BEFORE `destroyTitleEditor()` — a torn-down TipTap editor can't be queried.
   */
  function snapshotEditorTitle(): ResolvedTitleCommit | null {
    if (!titleEditor) return null;
    return resolveTitleCommitValues(titleEditor.getText(), titleEditor.getHTML(), 'New Tile');
  }

  /** The editor's value when it differs from the committed title, else null. */
  function uncommittedTitle(): ResolvedTitleCommit | null {
    const snap = snapshotEditorTitle();
    if (!snap) return null;
    const changed = snap.plain !== tile.title || (visibleHtml ?? '') !== (snap.titleHtml ?? '');
    return changed ? snap : null;
  }

  // A save or a leave commits a title typed but not yet committed.
  $effect(() => registerComponentFlush('tile title', () => (uncommittedTitle() ? commitTitleEdit() : undefined)));

  async function commitTitleEdit() {
    const snap = snapshotEditorTitle();
    destroyTitleEditor();
    isEditing = false;
    editingNewTile = false;
    if (!snap) return;
    await applyTitleCommit(snap, false);
  }

  /**
   * Applies a resolved title commit to the tile. A text tile's title is its
   * note's frontmatter `title:` (the file is never renamed); any other tile
   * owns its title on the board. `titleHtml` stays on the board either way.
   *
   * `fromTeardown` marks the unmount-time commit: by then the pane's scope may
   * already point at the switched-in board (the very switch that unmounted
   * us), so the command is filed on the tile's HOME board's undo stack (keyed
   * by `tile.boardId`) instead of the globally active one.
   */
  async function applyTitleCommit(snap: ResolvedTitleCommit, fromTeardown: boolean): Promise<void> {
    const { plain, titleHtml: newTitleHtml } = snap;
    const oldTitleHtml = visibleHtml ?? undefined;
    const titleChanged = plain !== tile.title;
    const titleHtmlChanged = (oldTitleHtml ?? '') !== (newTitleHtml ?? '');
    if (!titleChanged && !titleHtmlChanged) return;
    const cmd = new UpdateTitleCommand({
      tileId: tile.id,
      boardId: tile.boardId,
      notePath: tile.type === 'text' ? ((tile as TextTile).filePath ?? null) : null,
      oldTitle: tile.title,
      newTitle: plain,
      oldTitleHtml,
      newTitleHtml,
    });
    if (fromTeardown) {
      await cmd.execute();
      historyStore.pushWithoutExecuteOnBoard(cmd, tile.boardId);
    } else {
      await historyStore.execute(cmd).catch(() => {});
    }
  }

  function cancelTitleEdit() {
    destroyTitleEditor();
    isEditing = false;
    editingNewTile = false;
  }

  /**
   * An edit ended from the keyboard hands focus to the tile, so the board's
   * keys (a new tile, the arrows) work on from there instead of from the page.
   */
  function focusTileAfter(end: () => unknown): void {
    const container = titleEditorElement?.closest<HTMLElement>('.tile-container') ?? null;
    void end();
    container?.focus({ preventScroll: true });
  }

  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusTileAfter(commitTitleEdit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      focusTileAfter(editingNewTile ? commitTitleEdit : cancelTitleEdit);
    }
  }

  // Mount the inline TipTap editor once the host div binds.
  $effect(() => {
    if (isEditing && titleEditorElement && !titleEditor) {
      const initial = visibleHtml ?? `<p>${escapeForInitial(tile.title)}</p>`;
      titleEditor = createLabelEditor({
        element: titleEditorElement,
        content: initial,
        onFocus: () => {
          if (titleEditor) tiptapToolbar.setActiveEditor(titleEditor);
        },
        onTransaction: () => {
          if (titleEditor && tiptapToolbar.activeEditor === titleEditor) {
            tiptapToolbar.syncState();
          }
        },
      });
      // Focus the editor + select-all so the user can type to replace.
      queueMicrotask(() => {
        titleEditor?.commands.focus('end');
        titleEditor?.commands.selectAll();
      });
    }
  });

  // Clicking or tabbing away ends the edit and saves the title; the
  // formatting toolbar and its popups don't (see `titleEditFocus.ts`). The
  // host is bound only while editing, so the watch stops when the edit ends.
  $effect(() => {
    const host = titleEditorElement;
    if (!host) return;
    return commitWhenLeft(host, () => {
      if (titleEditor) void commitTitleEdit();
    });
  });

  // Guard against unmount during edit. A title typed but not committed (focus
  // just left, or the view closed while editing) is committed rather than
  // dropped: snapshot the editor's value BEFORE tearing it down, then commit
  // fire-and-forget (the rename helper is async-safe and self-guards when the
  // tile is already gone, e.g. mid-vault-swap).
  //
  // DEFER the commit one microtask past the synchronous
  // teardown so the `.md` rename doesn't race the board switch's own
  // reactivity, and `applyTitleCommit` pushes the undo command onto the tile's
  // HOME board's stack (see there) instead of dropping it. `snap` is captured
  // synchronously (before destroy), so the deferred call uses the right value.
  $effect(() => {
    return () => {
      const snap = uncommittedTitle();
      destroyTitleEditor();
      if (snap) queueMicrotask(() => void applyTitleCommit(snap, true));
    };
  });

  // Keyboard "rename" hook.
  // MindMapBoard's Enter handler dispatches a `request-rename` event
  // (with the focused tile's id) at the canvas container. The event
  // bubbles up to window; this listener filters by tileId and routes
  // into the same `startEditing()` flow the title double-click uses.
  $effect(() => {
    function onRequestRename(raw: Event) {
      const detail = (raw as CustomEvent<{ tileId: string }>).detail;
      if (!detail || detail.tileId !== tile.id) return;
      if (!isEditing) startEditing();
    }
    window.addEventListener('request-rename', onRequestRename);
    return () => window.removeEventListener('request-rename', onRequestRename);
  });

  function escapeForInitial(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function toggleLock() {
    const nextLocked = !tile.locked;
    boardStore.setTilesLockedWithHistory(
      new Map([[tile.id, tile.locked === true]]),
      nextLocked,
    );
  }

  // Toggle the media-only ("frameless") display. Routed through a command so
  // Ctrl+Z reverses it; when hidden, the header re-reveals on hover so this
  // same button (now "Show frame") is reachable to toggle back.
  function toggleFrameless(e: MouseEvent) {
    e.stopPropagation();
    historyStore.execute(
      new ToggleFramelessCommand([tile.id], tile.frameless !== true),
    );
  }

  /**
   * Opens a context-menu-style quick-action popup anchored to the broken-ref
   * badge. Offers Recreate backing file (a text tile only: puts the note back
   * at its path), Re-link (pick a different vault file via the modal picker)
   * and Remove (drops the placement). A media file can't be recreated from
   * anything Filo holds, so it gets no Recreate.
   */
  function openBrokenRefMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const recreate = tile.type === 'text'
      ? [{
          id: 'broken-recreate',
          label: 'Recreate backing file',
          icon: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
          action: () => { void recreateBackingFile(); },
        }]
      : [];
    uiStore.showContextMenu(rect.left, rect.bottom + 4, [
      ...recreate,
      {
        id: 'broken-relink',
        label: 'Re-link to another file…',
        icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
        action: () => {
          const targets = relinkTargets(tile.type);
          if (!targets) {
            uiStore.toast('Re-link not supported for this tile type.', 'warning', 3000);
            return;
          }
          uiStore.openRelinkModal(tile.id, targets);
        },
      },
      {
        id: 'broken-remove',
        label: 'Remove from board',
        icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
        danger: true,
        action: () => {
          // Route through removeTilesWithHistory so Ctrl+Z
          // restores the placement. No fileSnapshots needed: the backing
          // file is already missing (that's why we're removing the tile),
          // so DeleteTilesCommand's snapshots-absent path is exactly right
          // — it restores the placement and surfaces a broken-ref toast.
          selectionStore.deselect(tile.id);
          boardStore.removeTilesWithHistory([tile.id]);
          uiStore.toast('Broken-ref tile removed', 'success', 2000);
        },
      },
    ]);
  }

  function deleteTile() {
    uiStore.openConfirm({
      title: 'Delete Tile',
      body: `Are you sure you want to delete "${tile.title}"?`,
      confirmLabel: 'Delete',
      danger: true,
      extraOption: hasVaultFile
        ? {
            label: 'Delete associated file from vault as well?',
            hint: 'The .md file moves to Filo\'s trash, and any other tile showing it becomes a broken link. Undo, or restore it from Settings → Trash.',
            initial: false,
          }
        : undefined,
      onConfirm: (deleteWithFile) => { void performDeleteTile(deleteWithFile === true); },
    });
  }

  async function recreateBackingFile(): Promise<void> {
    const path = tile.type === 'text' ? tile.filePath : undefined;
    if (!path) return;
    try {
      const outcome = await recreateMissingNote(path);
      if (outcome === 'created') uiStore.toast(`Recreated "${path}".`, 'success', 3500);
      else uiStore.toast(`A file is back at "${path}"; nothing was overwritten.`, 'info', 3500);
    } catch (err) {
      reportError('TileHeader.recreate', err, `Couldn't recreate "${path}".`);
    }
  }

  async function performDeleteTile(deleteWithFile: boolean) {
    // Snapshot id + reference up-front: `boardStore.removeTile` triggers the
    // parent's reactive each-block to unmount this component, which nulls
    // out the `tile` prop. Subsequent reads of `tile.id` would throw.
    const tileId = tile.id;
    const tileRef = tile;

    // Drain pending writers first, so no debounced write can recreate the note
    // after it moved to the trash.
    // Only a failed write to the note being trashed blocks the delete.
    const filePaths = deleteWithFile && hasVaultFile ? textTileNotePaths([tileRef]) : [];
    try {
      await withDrainedWrites(async (drain) => {
        const vaultRoot = filePaths.length > 0 ? normalizePath(vaultStore.path) : undefined;
        selectionStore.deselect(tileId);
        boardStore.removeTilesWithHistory([tileId], { filePaths, vaultRoot, drain });
      }, { paths: filePaths });
    } catch (err) {
      if (err instanceof PendingWritesFailedError) {
        // Drain already toasted; bail without removing the tile.
        return;
      }
      throw err;
    }
  }

  function expandToDocument() {
    if (tile.type !== 'text') return;
    const path = (tile as TextTile).filePath;
    if (path) openNoteInDocumentTab(path);
  }

  // Header buttons stop propagation on `onclick` only so the
  // pointerdown drag on the parent `.tile-header-drag` doesn't start a
  // tile drag the moment the user presses a header button. We DO NOT add
  // oncontextmenu handlers here — right-click on a header button must
  // bubble to the board root's `oncontextmenu` (MindMapBoard /
  // KanbanColumn) so the user gets the tile context menu regardless of
  // where on the tile they right-clicked.
  function toggleStylePopup(e: MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    (e.currentTarget as HTMLElement).dispatchEvent(new CustomEvent('tile-style-popup', {
      bubbles: true,
      detail: { tile, x: rect.left, y: rect.bottom + 4 },
    }));
  }

  function toggleTagEditor(e: MouseEvent) {
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const anchor = getAnchorBelow(target);
    target.dispatchEvent(new CustomEvent('tile-tag-editor', {
      bubbles: true,
      detail: { tileId: tile.id, x: anchor.x, y: anchor.y },
    }));
    // Release :focus after click so the button doesn't read as permanently
    // highlighted when the TagEditor's focus trap returns focus on close.
    target.blur();
  }
</script>

<div class="tile-header" style="background: {headerBg};{headerTextColor ? ` --header-text-color: ${headerTextColor};` : ''}">
  <!-- Title -->
  <div class="tile-title-area">
    {#if isEditing}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tile-title-editor"
        style={titleFontStyle}
        bind:this={titleEditorElement}
        onkeydown={handleTitleKeydown}
      ></div>
    {:else if titleDisplay}
      <span
        class="tile-title"
        style={titleFontStyle}
        tabindex="0"
        role="button"
        aria-label="Tile title: {tile.title}. Press F2 or Enter to edit."
        ondblclick={startEditing}
        onkeydown={(e) => { if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); startEditing(); } }}
        title={tile.title}
      >{@html titleDisplay /* eslint-disable-line svelte/no-at-html-tags -- titleDisplay is sanitized via sanitizeInlineHtml (DOMPurify) in the $derived above */}</span>
    {:else}
      <span
        class="tile-title"
        style={titleFontStyle}
        tabindex="0"
        role="button"
        aria-label="Tile title: {tile.title}. Press F2 or Enter to edit."
        ondblclick={startEditing}
        onkeydown={(e) => { if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); startEditing(); } }}
        title={tile.title}
      >{tile.title}</span>
    {/if}
    {#if tile.locked}
      <span
        class="tile-locked-badge-inline"
        title="This tile is locked. Use the lock button to unlock."
        aria-label="Locked"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </span>
    {/if}
    {#if isBroken}
      <button
        type="button"
        class="tile-broken-badge-inline"
        title="Backing file is missing. Click for quick actions."
        aria-label="Broken file reference. Click for quick actions."
        onclick={openBrokenRefMenu}
      >!</button>
    {/if}
  </div>

  <!-- Header buttons -->
  <div class="tile-header-buttons">
    <!-- Tags -->
    <button class="header-btn" title="Tags" aria-label="Edit tags" onclick={toggleTagEditor}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
    </button>

    <!-- Lock -->
    <button class="header-btn" class:active={tile.locked} title={tile.locked ? 'Unlock' : 'Lock'} aria-label={tile.locked ? 'Unlock tile' : 'Lock tile'} onclick={toggleLock}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#if tile.locked}
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        {:else}
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
        {/if}
      </svg>
    </button>

    <!-- Frameless (media-only) toggle — media tiles only -->
    {#if isMediaTile}
      <button
        class="header-btn"
        class:active={tile.frameless}
        title={tile.frameless ? 'Show frame' : 'Hide frame (media only)'}
        aria-label={tile.frameless ? 'Show tile frame' : 'Hide tile frame, show media only'}
        aria-pressed={tile.frameless === true}
        onclick={toggleFrameless}
      >
        {#if tile.frameless}
          <!-- Restore frame: panel with a header bar -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
          </svg>
        {:else}
          <!-- Hide frame: expand-to-fill corners -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>
          </svg>
        {/if}
      </button>
    {/if}

    <!-- Style -->
    <button class="header-btn" title="Style" aria-label="Tile style options" onclick={toggleStylePopup}>
      <StyleIcon size={14} />
    </button>

    <!-- Expand to Document (Text tile only) -->
    {#if tile.type === 'text'}
      <button class="header-btn" title="Expand to Document" aria-label="Expand to document" onclick={expandToDocument}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
      </button>
    {/if}

    <!-- Delete -->
    <button class="header-btn danger" title="Delete" aria-label="Delete tile" onclick={deleteTile}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .tile-header {
    display: flex;
    align-items: center;
    padding: 4px 6px 4px 10px;
    min-height: 30px;
    gap: 4px;
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
  }

  .tile-title-area {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tile-broken-badge-inline {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: 0;
    padding: 0;
    border-radius: 50%;
    background: var(--accent-danger);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    flex-shrink: 0;
    cursor: pointer;
    transition: transform 0.15s ease;
  }

  .tile-broken-badge-inline:hover,
  .tile-broken-badge-inline:focus-visible {
    transform: scale(1.15);
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }

  .tile-locked-badge-inline {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--header-text-color, var(--text-secondary));
    opacity: 0.75;
    flex-shrink: 0;
    cursor: help;
  }

  .tile-title {
    font-size: var(--font-size-tile-title, 14px);
    font-weight: 600;
    color: var(--header-text-color, var(--text-primary));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    max-width: 100%;
    cursor: text;
  }

  /* TipTap editor host while the title is being edited. ProseMirror writes
     its `contenteditable` div as a child; we style only the container and
     let the editor's inline marks (color/highlight/bold/...) render
     naturally. */
  .tile-title-editor {
    width: 100%;
    font-size: var(--font-size-tile-title, 14px);
    font-weight: 600;
    color: var(--header-text-color, var(--text-primary));
    background: transparent;
    border-bottom: 1px solid var(--accent-primary);
    outline: none;
    padding: 0;
  }
  .tile-title-editor :global(.ProseMirror) {
    outline: none;
    min-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tile-title-editor :global(.ProseMirror p) {
    margin: 0;
  }
  /* Inline marks should display inline within the title row even though
     the editor wraps them in a paragraph. */
  .tile-title :global(p) {
    margin: 0;
    display: inline;
  }

  .tile-header-buttons {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  :global(.tile-container:hover) .tile-header-buttons,
  :global(.tile-container:focus-within) .tile-header-buttons,
  :global(.tile-container.selected) .tile-header-buttons,
  :global(.tile-container.force-show-buttons) .tile-header-buttons {
    opacity: 1;
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--header-text-color, var(--text-secondary));
    opacity: 0.75;
    transition: background-color 0.1s ease, color 0.1s ease, opacity 0.1s ease;
  }

  .header-btn:hover {
    background: var(--ui-surface-hover);
    opacity: 1;
  }

  .header-btn:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
    opacity: 1;
  }

  .header-btn.active {
    color: var(--accent-primary);
    opacity: 1;
  }

  .header-btn.danger:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
    opacity: 1;
  }

</style>
