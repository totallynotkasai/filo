<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import type { BoardType, FileTreeNode } from '../../../shared/types';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import { buildSidebarFileMenu } from '../../lib/vault/sidebarFileMenu';
  import { newFolderIn, newNoteIn } from '../../lib/vault/sidebarNewItems';
  import { renameNoteFileToTitle } from '../../lib/notes/renameToTitle';
  import { renameVaultEntry } from '../../lib/vault/renameVaultEntry';
  import { fileNameProblem } from '@shared/fileNames';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { normalizePath, samePath, toPosix, toVaultRelative } from '../../lib/utils/path';
  import { getActiveContentFolder } from '../../lib/vault/conventionPaths';
  import { getAnchorBelow } from '../../lib/utils/popupAnchor';
  import { sidebarTagFilter } from '../../stores/sidebarTagFilter.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { copyFileIntoVault } from '../../lib/vault/vaultOperations';
  import { ProgressiveCount } from '../../lib/utils/progressiveCount.svelte';
  import { adoptAndFindBoard } from '../../stores/boardDiscovery';
  import {
    basenameOf,
    describeMoveIntoFolderFailure,
  } from '../../lib/vault/moveIntoFolderFeedback';
  import FileTagChips from './FileTagChips.svelte';
  import FileIcon from './FileIcon.svelte';
  import VaultFileItem from './VaultFileItem.svelte';

  /** svelte-dnd-action requires `id` on every item — node.path is unique. */
  type DndNode = { id: string; node: FileTreeNode };

  interface Props {
    node: FileTreeNode;
    depth?: number;
  }

  let { node, depth = 0 }: Props = $props();

  let isRenaming = $state(false);
  let renameValue = $state('');
  // Why the typed name can't be used (illegal character, reserved name),
  // shown inline beside the input. The name is never silently changed.
  let renameProblem = $derived(isRenaming ? fileNameProblem(renameValue.trim()) : null);
  let isNoteFile = $derived(!node.isDirectory && /\.(md|markdown)$/i.test(node.name));
  let isDropTarget = $state(false);
  let autoExpandTimer: ReturnType<typeof setTimeout> | null = null;

  // Clear the hover auto-expand timer on unmount. Without
  // this, a vault swap (or any unmount) while the timer is armed mid-drag-hover
  // fires `vaultStore.toggleFolder(node.path)` ~600 ms later against the
  // swapped-in vault. drag-leave / drop already clear it; this covers unmount.
  onDestroy(() => {
    if (autoExpandTimer != null) clearTimeout(autoExpandTimer);
  });

  // Auto-enter rename mode when this node was just created
  // via the sidebar's "New Folder" button. The toolbar sets
  // `uiStore.pendingSidebarRenameId` to the new folder's absolute path; the
  // first VaultFileItem whose `node.path` matches consumes the flag,
  // enters rename mode, and clears it so a re-render doesn't loop. We
  // depend on `node.path` so a freshly-rendered node picks up the signal
  // even when the tree refresh that surfaces it lands after the flag was
  // set.
  $effect(() => {
    if (!uiStore.pendingSidebarRenameId) return;
    if (uiStore.pendingSidebarRenameId === node.path) {
      uiStore.setPendingSidebarRenameId(null);
      startRename();
    }
  });

  function vaultRelativePath(): string {
    // The sidebar's node.path is absolute. Strip the vault root so tags.json
    // keys stay vault-relative (the same shape used by board JSON, vault
    // index, and the file watcher).
    return toVaultRelative(node.path, vaultStore.path) ?? toPosix(node.path);
  }

  // ── The one folder pin: where new files go ──
  // With board folders on, the tree button sets the active board's own folder
  // (`settings.defaultFolder`); with them off, the vault-wide Root Directory.
  // It is green on `getActiveContentFolder`, so the green button is always
  // where files go (a board with no folder of its own uses the Root
  // Directory). `boardStore.settingsVersion` is read so
  // the board pin re-evaluates on every settings mutation (Svelte 5's proxy
  // tracker doesn't always notify when `settings.defaultFolder` is first
  // stamped onto a board).
  const activeBoard = $derived(boardStore.current);
  const boardFolders = $derived(vaultStore.project?.settings?.general?.boardFolders === true);
  const pinnedFolderAbs = $derived.by(() => {
    void boardStore.settingsVersion;
    const rel = getActiveContentFolder(activeBoard);
    return rel && vaultStore.path ? `${vaultStore.path.replace(/[\\/]+$/, '')}/${rel}` : '';
  });
  const isPinnedHere = $derived(node.isDirectory && samePath(pinnedFolderAbs, node.path));
  const pinDisabled = $derived(boardFolders && !activeBoard);

  function togglePin(e: MouseEvent): void {
    e.stopPropagation();
    if (boardFolders) boardStore.setBoardDefaultFolder(node.path);
    else vaultStore.setActiveRootFolder(node.path);
  }

  function openTagEditor(e: MouseEvent) {
    e.stopPropagation();
    // The sidebar emits a global custom event picked up by VaultSidebar,
    // which mounts a single TagEditor (file-path mode) at the row's anchor.
    // Same dispatch idiom canvas tile headers use for `tile-tag-editor`.
    const target = e.currentTarget as HTMLElement;
    const anchor = getAnchorBelow(target);
    target.dispatchEvent(new CustomEvent('vault-file-tag-editor', {
      bubbles: true,
      detail: {
        filePath: vaultRelativePath(),
        x: anchor.x,
        y: anchor.y,
      },
    }));
  }

  // Folder open/closed state goes through the tag filter, which shows every
  // folder holding a match open without touching the user's own expansion.
  const isExpanded = $derived(sidebarTagFilter.isFolderExpanded(node.path));
  // Reordering a cut-down list would drop the hidden rows' ranks; under a
  // Group By, a row dropped into another group would jump back to its own.
  const reorderDisabled = $derived(
    vaultStore.sortField !== 'none' || vaultStore.groupField !== 'none' || vaultStore.search !== '' || sidebarTagFilter.active,
  );

  const isSelected = $derived(vaultStore.isSelected(node.path));

  // Local mirror of children for svelte-dnd-action. The library expects to
  // own the items array during a drag; a writable $derived lets us re-sync
  // from `node.children` whenever the tree updates externally while still
  // permitting the library to reassign during a drag gesture.
  let childDndItems: DndNode[] = $derived(
    (node.children ?? []).map((c) => ({ id: c.path, node: c })),
  );

  // A large folder renders its first rows at once and the rest in idle time;
  // reordering waits until every row is there (the zone's items must be all
  // of them, or a drop would drop the unrendered rows' ranks).
  const shownChildren = new ProgressiveCount(() => childDndItems.length);
  $effect(() => {
    if (!isExpanded) return;
    untrack(() => shownChildren.start());
    return () => shownChildren.stop();
  });
  const renderedChildItems = $derived(
    shownChildren.complete ? childDndItems : childDndItems.slice(0, shownChildren.shown),
  );

  function onChildConsider(e: CustomEvent<DndEvent<DndNode>>) {
    childDndItems = e.detail.items;
  }
  function onChildFinalize(e: CustomEvent<DndEvent<DndNode>>) {
    childDndItems = e.detail.items;
    if (vaultStore.sortField === 'none') {
      vaultStore.setManualOrder(node.path, e.detail.items.map((i) => i.id));
    }
  }
  const showExtensions = $derived(
    vaultStore.project?.settings?.general?.showFileExtensions ?? false,
  );
  const displayName = $derived.by(() => {
    if (node.isDirectory || showExtensions || !node.extension) return node.name;
    return node.name.endsWith(node.extension)
      ? node.name.slice(0, -node.extension.length)
      : node.name;
  });

  // A note the sidebar's search found by its title, not its file name: the
  // title shows beside the name, so the row says why it is listed.
  const matchedTitle = $derived.by(() => {
    const query = vaultStore.search.toLowerCase();
    if (!query || node.isDirectory || node.name.toLowerCase().includes(query)) return null;
    const title = vaultStore.searchTitleOf(node);
    return title && title.toLowerCase().includes(query) ? title : null;
  });

  function toggleExpand() {
    if (node.isDirectory) {
      sidebarTagFilter.toggleFolder(node.path);
    }
  }

  function handleRowClick(e: MouseEvent) {
    // Ctrl/Cmd builds up a selection without expanding folders so users can
    // grab several files for a single drag-into-folder move.
    if (e.ctrlKey || e.metaKey) {
      vaultStore.toggleSelection(node.path);
      return;
    }
    vaultStore.selectOnly(node.path);
    toggleExpand();
  }

  // The row is a focusable treeitem, not a <button> (its tag chips are
  // buttons, which can't nest in one), so it takes Enter / Space itself.
  // Keys from the chips or the rename input are theirs.
  function handleRowKeydown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleRowClick(new MouseEvent('click', { ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
  }

  // Normalised descendant check — used to forbid dropping a folder into its
  // own subtree (which would orphan the move on disk).
  function isDescendant(parent: string, child: string): boolean {
    return normalizePath(child).startsWith(normalizePath(parent) + '/');
  }

  function isDropPayload(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return (
      types.includes('application/x-vault-file') ||
      types.includes('application/x-vault-files') ||
      types.includes('Files')
    );
  }

  function handleFolderDragEnter(e: DragEvent) {
    if (!node.isDirectory) return;
    if (!isDropPayload(e)) return;
    e.preventDefault();
    isDropTarget = true;

    // Auto-expand after 600ms hover so users can drop into nested folders
    // without having to first click the disclosure chevron.
    if (!isExpanded && autoExpandTimer == null) {
      autoExpandTimer = setTimeout(() => {
        autoExpandTimer = null;
        if (!isExpanded) sidebarTagFilter.toggleFolder(node.path);
      }, 600);
    }
  }

  function handleFolderDragOver(e: DragEvent) {
    if (!node.isDirectory) return;
    if (!isDropPayload(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move';
    }
    isDropTarget = true;
  }

  function handleFolderDragLeave(e: DragEvent) {
    // ondragleave fires when entering a child element; ignore those.
    if (e.relatedTarget && (e.currentTarget as HTMLElement)?.contains(e.relatedTarget as Node)) {
      return;
    }
    isDropTarget = false;
    if (autoExpandTimer != null) {
      clearTimeout(autoExpandTimer);
      autoExpandTimer = null;
    }
  }

  async function handleFolderDrop(e: DragEvent) {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation(); // don't bubble to the sidebar's root drop zone
    isDropTarget = false;
    if (autoExpandTimer != null) {
      clearTimeout(autoExpandTimer);
      autoExpandTimer = null;
    }

    // Branch 1a — internal multi-select move (Ctrl+click then drag).
    const rawMulti = e.dataTransfer?.getData('application/x-vault-files');
    if (rawMulti) {
      try {
        const payloads = JSON.parse(rawMulti) as { path: string }[];
        for (const p of payloads) {
          if (!p?.path) continue;
          if (p.path === node.path) continue;
          if (isDescendant(p.path, node.path)) continue;
          const result = await vaultStore.moveIntoFolder(p.path, node.path);
          if (!result.ok) {
            uiStore.toast(
              describeMoveIntoFolderFailure(result, basenameOf(p.path), node.name),
              result.code === 'PERMISSION_DENIED' ? 'error' : 'warning',
            );
          }
        }
      } catch (err) {
        reportError('VaultFileItem.folder-multi-drop', err, `Failed to move one or more files into "${node.name}"`);
      }
      vaultStore.clearSelection();
      return;
    }

    // Branch 1b — internal single-item move (drag-from-sidebar).
    const raw = e.dataTransfer?.getData('application/x-vault-file');
    if (raw) {
      try {
        const payload = JSON.parse(raw) as { path: string };
        if (!payload?.path) return;
        if (payload.path === node.path) return;
        if (isDescendant(payload.path, node.path)) return;
        const result = await vaultStore.moveIntoFolder(payload.path, node.path);
        if (!result.ok) {
          uiStore.toast(
            describeMoveIntoFolderFailure(result, basenameOf(payload.path), node.name),
            result.code === 'PERMISSION_DENIED' ? 'error' : 'warning',
          );
        }
      } catch (err) {
        reportError('VaultFileItem.folder-drop', err, `Failed to move file into "${node.name}"`);
      }
      return;
    }

    // Branch 2 — OS-external file drop. Copy each file into this folder.
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const destFolder = vaultRelativePath();
    for (const file of Array.from(files)) {
      // Electron exposes the OS file path on `File`; `webUtils.getPathForFile`
      // (preload-bridged) is the supported lookup under sandbox + isolation.
      // Probe both behind a narrow type projection rather than a blanket
      // escape hatch.
      const fileWithPath = file as File & { path?: unknown };
      let sourcePath: string | undefined =
        typeof fileWithPath.path === 'string' ? fileWithPath.path : undefined;
      if (!sourcePath) {
        try {
          sourcePath = window.filo.getPathForFile?.(file) ?? undefined;
        } catch {
          /* bridge unavailable in some windows */
        }
      }
      if (!sourcePath) continue;
      try {
        // Drain pending writers before the copy so a
        // debounced editor write targeting the destination folder
        // doesn't race the new file's creation. `copyFileIntoVault`
        // returns the envelope verbatim; non-success surfaces a toast
        // via reportError below.
        const res = await copyFileIntoVault(sourcePath, vaultRoot, destFolder);
        if (!res.success) {
          reportError(
            'VaultFileItem.external-drop',
            new Error(res.error ?? 'vault:copy-file returned !success'),
            `Failed to copy "${file.name}" into "${node.name}"`,
          );
        }
      } catch (err) {
        reportError('VaultFileItem.external-drop', err, `Failed to copy "${file.name}" into "${node.name}"`);
      }
    }
    await vaultStore.refreshTree();
  }

  function handleDoubleClick() {
    if (node.isDirectory) return;
    const lowerName = node.name.toLowerCase();
    const ext = (node.extension ?? '').toLowerCase();
    const relPath = vaultRelativePath();

    // .board.json → open or focus the board tab. The tabStore dedupes by
    // boardId, so a second double-click just focuses the existing tab.
    if (lowerName.endsWith('.board.json')) {
      const paths = boardCacheStore.paths;
      const target = toPosix(relPath).toLowerCase();
      const boardId = Object.keys(paths).find(
        (id) => toPosix(paths[id] ?? '').toLowerCase() === target,
      );
      const board = boardId
        ? vaultStore.project?.boards?.find((b) => b.id === boardId)
        : undefined;
      // An untracked board (appeared mid-session / failed at open) is adopted, then opened.
      if (board) tabStore.open(board.id, board.name, board.type as BoardType, board.emoji ?? '');
      else void adoptAndFindBoard(relPath).then((b) => b && tabStore.open(b.id, b.name, b.type as BoardType, b.emoji ?? ''));
      return;
    }

    // .md / .markdown → open or focus a document tab. Every view of one path
    // shares one document entry.
    if (ext === '.md' || ext === '.markdown') {
      openNoteInDocumentTab(relPath);
      return;
    }

    // Other file types: drag-to-canvas remains the open path.
  }

  let renameInputEl = $state<HTMLInputElement | null>(null);
  function startRename() {
    isRenaming = true;
    renameValue = displayName;
  }

  // Auto-focus + select-all when the rename input mounts. Benefits both
  // the context-menu Rename entry and the auto-rename-after-create
  // path. `tick`-equivalent: the bind populates before this effect runs
  // because Svelte mounts the input synchronously after isRenaming flips.
  $effect(() => {
    if (isRenaming && renameInputEl) {
      renameInputEl.focus();
      renameInputEl.select();
    }
  });

  async function commitRename() {
    if (!isRenaming) return; // Escape set isRenaming=false, then the input's blur fired here — don't commit the rename the user aborted.
    // An unusable name is never sent: the inline message already explains it,
    // and a blur with it still showing abandons the rename.
    if (renameProblem) {
      isRenaming = false;
      return;
    }
    isRenaming = false;
    const draft = renameValue.trim();
    if (!draft) return;
    await renameVaultEntry(node, draft);
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      // The rename may open a notice; this key's keypress must not press it.
      e.preventDefault();
      // Keep editing while the name is unusable; the message says why.
      if (renameProblem) return;
      commitRename();
    } else if (e.key === 'Escape') {
      isRenaming = false;
    }
  }

  async function handleDelete() {
    // `vaultStore.delete` surfaces IPC failures from
    // inside the store (it has the error code; we don't). We don't need
    // a wrapper toast here.
    await vaultStore.delete(node.path);
  }

  async function revealInExplorer() {
    try {
      await window.filo.invoke('shell:show-item-in-folder', node.path);
    } catch (err) {
      reportError('VaultFileItem.reveal', err, `Could not reveal "${node.name}" in the file explorer`);
    }
  }

  function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const cursor = { x: e.clientX, y: e.clientY };
    uiStore.showContextMenu(e.clientX, e.clientY, buildSidebarFileMenu({
      isDirectory: node.isDirectory,
      isNote: isNoteFile,
      onNewNote: () => { void newNoteIn(node.path); },
      onNewFolder: () => { void newFolderIn(node.path); },
      onTags: () => {
        // Match the icon button dispatch so the TagEditor mounts via
        // VaultSidebar's single shared host instead of an inline popover.
        document.dispatchEvent(new CustomEvent('vault-file-tag-editor', {
          bubbles: true,
          detail: { filePath: vaultRelativePath(), x: cursor.x, y: cursor.y },
        }));
      },
      onRename: () => startRename(),
      onRenameToTitle: () => { void renameNoteFileToTitle(vaultRelativePath()); },
      onReveal: () => { void revealInExplorer(); },
      onDelete: () => { void handleDelete(); },
    }));
  }

</script>

<div class="vault-file-item" class:drop-target={isDropTarget} class:selected={isSelected} style="padding-left: {12 + depth * 16}px">
  <!-- Sidebar reorder uses this explicit handle (svelte-dnd-action);
       native HTML5 drag stays on `.file-row` so canvas/column/section
       drops keep firing. See `.drag-handle` CSS below for rationale. -->
  {#if !reorderDisabled}
    <span class="drag-handle" use:dragHandle aria-label="Drag to reorder {displayName}" title="Drag to reorder">
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2" /><circle cx="7" cy="3" r="1.2" /><circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="3" cy="11" r="1.2" /><circle cx="7" cy="11" r="1.2" /></svg>
    </span>
  {/if}
  <div
    class="file-row"
    class:is-directory={node.isDirectory}
    role="treeitem"
    tabindex="0"
    aria-level={depth + 1}
    aria-selected={isSelected}
    aria-expanded={node.isDirectory ? isExpanded : undefined}
    onclick={handleRowClick}
    onkeydown={handleRowKeydown}
    ondblclick={handleDoubleClick}
    oncontextmenu={openContextMenu}
    title={node.path}
    draggable={true}
    ondragstart={(e) => {
      if (!e.dataTransfer) return;
      // svelte-dnd-action attaches `ondragstart = () => false` to the
      // dndzone's direct child (`.vault-file-item`) via its `styleDraggable`
      // helper. Our dragstart on `.file-row` bubbles up to that parent and
      // the library's `() => false` handler aborts the drag — which is why
      // a click-and-hold on the row produced no drag ghost. Stop the bubble
      // here so the native HTML5 drag survives and the canvas / column /
      // section drop handlers receive the `application/x-vault-file` payload.
      e.stopPropagation();
      const selected = vaultStore.selectedPaths;
      // Multi-drag: when the user has Ctrl+selected several rows and is
      // dragging one of them, ship the whole set under a plural MIME type
      // and omit the singular `application/x-vault-file` so the canvas
      // drop handler (which listens for the singular type) can't accept it.
      if (selected.size > 1 && selected.has(node.path)) {
        const ordered = Array.from(selected);
        e.dataTransfer.setData('text/plain', ordered.join('\n'));
        e.dataTransfer.setData(
          'application/x-vault-files',
          JSON.stringify(
            ordered.map((path) => ({ path })),
          ),
        );
        e.dataTransfer.effectAllowed = 'move';
        return;
      }
      // Single-drag: keep the selection coherent with what's being dragged.
      vaultStore.selectOnly(node.path);
      e.dataTransfer.setData('text/plain', node.path);
      e.dataTransfer.setData(
        'application/x-vault-file',
        JSON.stringify({
          path: node.path,
          name: node.name,
          extension: node.extension,
          isDirectory: node.isDirectory,
        }),
      );
      // 'copyMove' lets the canvas drop handler treat it as a copy (place a
      // tile referencing the file) while the sidebar drop handler treats it
      // as a move (rename into a folder).
      e.dataTransfer.effectAllowed = 'copyMove';
    }}
    ondragenter={handleFolderDragEnter}
    ondragover={handleFolderDragOver}
    ondragleave={handleFolderDragLeave}
    ondrop={handleFolderDrop}
  >
    <span class="file-icon" aria-hidden="true">
      <FileIcon {node} expanded={isExpanded} />
    </span>

    {#if isRenaming}
      <input
        class="rename-input"
        type="text"
        bind:this={renameInputEl}
        bind:value={renameValue}
        onblur={commitRename}
        onkeydown={handleRenameKeydown}
        aria-label="Rename {displayName}"
        aria-invalid={renameProblem ? 'true' : undefined}
        aria-describedby={renameProblem ? 'rename-problem-' + node.path : undefined}
      />
      {#if renameProblem}
        <span class="rename-problem" id={'rename-problem-' + node.path} role="alert">{renameProblem}</span>
      {/if}
    {:else}
      <span class="file-label">
        <span class="file-name">{displayName}</span>
        {#if matchedTitle}
          <span class="file-title-match" title={matchedTitle}>{matchedTitle}</span>
        {/if}
        {#if !node.isDirectory}
          <FileTagChips filePath={vaultRelativePath()} />
        {/if}
      </span>
    {/if}
  </div>

  <div
    class="file-actions"
    class:has-pinned-active={isPinnedHere}
  >
    {#if node.isDirectory}
      <!--
        Root Directory toggle: the one folder pin. When active (green), new
        files (tiles, cards, tasks, drops, recordings, picked files, images)
        land inside this folder instead of the vault root. With board folders
        on it is the active board's folder, saved in its .board.json, and is
        disabled while no board is open; with them off it is vault-wide,
        saved in .filo/app.json. Stays visible when the row isn't hovered so
        the user can see at a glance which folder is selected.
      -->
      <button
        class="action-btn root-dir-btn"
        class:active={isPinnedHere}
        disabled={pinDisabled}
        onclick={togglePin}
        title={pinDisabled
          ? 'Open a board to choose its folder'
          : boardFolders
            ? `Use as the folder for board "${activeBoard?.name ?? ''}"`
            : 'Use as Root Directory for new tiles and dropped files'}
        aria-pressed={isPinnedHere}
        aria-label="Toggle Root Directory for {node.name}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 10a7 7 0 0 0-14 0"/>
          <path d="M12 3v18"/>
          <path d="M8 21h8"/>
          <path d="M5 10h2"/>
          <path d="M17 10h2"/>
        </svg>
      </button>
    {:else}
      <button class="action-btn" onclick={openTagEditor} title="Edit tags" aria-label="Edit tags for {node.name}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
      </button>
    {/if}
    <button class="action-btn" onclick={startRename} title="Rename" aria-label="Rename {node.name}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
    </button>
    <button class="action-btn danger" onclick={handleDelete} title="Delete" aria-label="Delete {node.name}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
    </button>
  </div>

</div>

{#if node.isDirectory && isExpanded && node.children}
  <!--
    Per-folder dnd zone. Unique `type` per parent path so the library
    won't accept items dragged in from other zones (cross-folder moves
    remain a filesystem op handled by the existing HTML5 drop handler
    on the folder row itself). Active only when Sort By is "None".
  -->
  <div
    class="child-dnd-zone"
    use:dragHandleZone={{
      items: renderedChildItems,
      type: `vault-order:${node.path}`,
      // Disabled while search or a tag filter is on, for the same reason as the root zone
      // (see VaultSidebar.svelte) — partial item lists would clobber ranks.
      dragDisabled: reorderDisabled || !shownChildren.complete,
      flipDurationMs: 150,
      dropTargetStyle: {},
    }}
    onconsider={onChildConsider}
    onfinalize={onChildFinalize}
  >
    {#each renderedChildItems as item (item.id)}
      <VaultFileItem node={item.node} depth={depth + 1} />
    {/each}
  </div>
{/if}

<style>
  .vault-file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 26px;
    margin: 0 4px;
    border-radius: 4px;
    /* Anchor for `.file-actions`'s absolute positioning (see below). */
    position: relative;
    transition: background-color 0.08s ease, box-shadow 0.08s ease;
  }

  .vault-file-item.drop-target {
    background: var(--ui-surface-active, rgba(58, 134, 255, 0.18));
    box-shadow: inset 0 0 0 1px var(--accent-primary, #3a86ff);
  }

  /* Multi-select highlight — applied when the user has Ctrl/Cmd-clicked
     this row. Visually mirrors the drop-target idiom so the user reads
     both states with the same vocabulary. */
  .vault-file-item.selected {
    background: var(--ui-surface-active, rgba(58, 134, 255, 0.18));
    box-shadow: inset 0 0 0 1px var(--accent-primary, #3a86ff);
  }
  .vault-file-item.selected .file-row {
    background: transparent;
  }

  /*
   * Sidebar reorder handle. svelte-dnd-action's `dragHandle` action is
   * bound here so its mousedown only initiates the in-vault reorder when
   * the user grabs THIS element; pointerdown anywhere else on the row goes
   * to the native HTML5 drag bound to `.file-row` (which carries the
   * `application/x-vault-file` payload that boards consume). Without the
   * split, dnd-action's item-wide pointer listener swallowed mousedown and
   * the native dragstart never fired, so drops onto boards snapped back.
   *
   * Always-on at low opacity for discoverability; brightens on row hover
   * so users see it without having to hunt. `cursor: grab` is set by the
   * `dragHandle` action itself.
   */
  .drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 12px;
    height: 18px;
    margin-right: 2px;
    color: var(--text-tertiary);
    opacity: 0.35;
    transition: opacity 0.12s ease, color 0.12s ease;
    touch-action: none;
  }
  .vault-file-item:hover .drag-handle {
    opacity: 0.85;
    color: var(--text-secondary);
  }
  .drag-handle:focus-visible {
    outline: 2px solid var(--accent-primary, #3a86ff);
    outline-offset: 1px;
    border-radius: 2px;
    opacity: 1;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    /* Right padding reserves the visual area for the absolutely-positioned
       `.file-actions` overlay so the filename text never runs *underneath*
       the action buttons. The padding stays whether buttons are visible
       (hover) or not, matching the layout of the original flex-flow
       version where `.file-actions` always reserved space. */
    padding: 2px 100px 2px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.08s ease;
  }

  /* A file row has three action buttons (3 × 22px + gaps), a folder four. */
  .file-row:not(.is-directory) {
    padding-right: 78px;
  }

  .file-row:hover {
    background: var(--ui-surface-hover);
  }

  .file-row:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: -2px;
  }

  .file-row:active {
    background: var(--ui-surface-active);
  }

  .file-row.is-directory {
    font-weight: 500;
    color: var(--text-secondary);
  }

  .file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: var(--text-secondary);
  }
  .file-row.is-directory .file-icon {
    color: var(--accent-primary);
  }

  /* Name and chips share one clipped box inside the row's content area, so
     a chip that doesn't fit is cut off rather than sliding under the hover
     actions in the reserved right padding. */
  .file-label {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  /* The chips shrink first (to their minimum); only then does the name. */
  .file-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* The title a search found the row by gives way first, so the file name stays readable. */
  .file-title-match {
    flex: 0 1000 auto;
    min-width: 0;
    margin-left: 6px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 1px 4px;
    border: 1px solid var(--ui-border-focus);
    border-radius: 3px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .rename-input:focus:not(:focus-visible) {
    outline: none;
  }

  .rename-input[aria-invalid='true'] {
    border-color: var(--accent-danger);
  }

  .rename-problem {
    flex-shrink: 0;
    max-width: 55%;
    padding: 0 4px;
    color: var(--accent-danger);
    font-size: var(--font-size-sm, 11px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
   * `.file-actions` is overlaid on the right edge of the row (absolute) so it
   * doesn't steal flex space from `.file-row`. `.file-row` now spans the full
   * row width, which means the user can grab the row from anywhere — not just
   * the icon/name strip — to start an HTML5 drag to a board. The wrapper has
   * `pointer-events: none` so the 2-px gaps between buttons fall *through* to
   * `.file-row` underneath; the buttons themselves re-enable pointer events
   * so their clicks still fire.
   */
  .file-actions {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }

  .vault-file-item:hover .file-actions, .vault-file-item:focus-within .file-actions, /* keyboard focus reveals row actions (WCAG 2.4.7), mirrors TileHeader */
  .file-actions.has-pinned-active {
    opacity: 1;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  /*
   * Re-enable pointer events on individual buttons only when the
   * `.file-actions` wrapper is visible (row hover, or a pinned-active
   * folder). When invisible, the buttons must remain non-interactive so
   * mousedown on the right-hand area of the row falls *through* to
   * `.file-row` underneath, starting an HTML5 drag.
   */
  .vault-file-item:hover .file-actions .action-btn, .vault-file-item:focus-within .file-actions .action-btn,
  .file-actions.has-pinned-active .action-btn {
    pointer-events: auto;
  }

  .action-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .action-btn.danger:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  /* Root Directory toggle — turns green when this folder is the active
     drop destination for new tiles. When inactive, hidden siblings of
     `.file-actions` (only revealed on row hover); when active, the parent
     gets `.has-pinned-active` so the green icon stays visible always. */
  .action-btn.root-dir-btn.active {
    color: var(--accent-success, #2ea043);
  }
  .action-btn.root-dir-btn.active:hover {
    color: var(--accent-success, #2ea043);
    background: var(--ui-surface-hover);
  }

  .action-btn[disabled] {
    opacity: 0.4;
    cursor: default;
  }
  .action-btn[disabled]:hover {
    background: transparent;
    color: var(--text-secondary);
  }

  /* Wrapper around the dnd-action zone for nested children. Block layout
     so the library can hit-test against its bounding box; default flow is
     unchanged for the children themselves. */
  .child-dnd-zone {
    display: block;
  }
</style>
