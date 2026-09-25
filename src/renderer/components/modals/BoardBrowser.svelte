<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { tick } from 'svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { workspaceStore } from '../../stores/workspace.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { createId } from '../../lib/utils/ids';
  import { computeKeyboardReorder } from '../../lib/boards/boardReorder';
  import type { BoardType } from '../../../shared/types';
  import type { Board } from '../../schema/index';
  import { boardRegistry } from '../../core/boardRegistry';

  let searchQuery = $state('');
  let showNewBoard = $state(false);
  let newBoardName = $state('');
  let newBoardType = $state<BoardType>('mindmap');

  // E.10 — disable Create when the typed name is empty or already in use.
  // Lower-case compare so "Notes" vs "notes" collisions still flag (board
  // file paths are case-insensitive on Windows/mac).
  const takenBoardNames = $derived(
    new Set(
      (vaultStore.project?.boards ?? []).map((b) => b.name.trim().toLowerCase()),
    ),
  );
  const trimmedNewBoardName = $derived(newBoardName.trim());
  const newBoardNameError = $derived.by(() => {
    if (!showNewBoard) return null;
    if (trimmedNewBoardName === '') return null; // empty is "not yet ready", not an error
    if (takenBoardNames.has(trimmedNewBoardName.toLowerCase())) {
      return `A board named "${trimmedNewBoardName}" already exists.`;
    }
    return null;
  });
  const canCreateBoard = $derived(
    trimmedNewBoardName !== '' && newBoardNameError === null,
  );

  // Auto-suggest a non-colliding name so the user can hit Create without typing.
  function suggestBoardName(): string {
    const taken = new Set(
      (vaultStore.project?.boards ?? []).map((b) => b.name),
    );
    const base = 'Untitled Board';
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  function openNewBoardForm() {
    showNewBoard = !showNewBoard;
    if (showNewBoard) newBoardName = suggestBoardName();
  }
  let renamingBoardId = $state<string | null>(null);
  let renameValue = $state('');
  let renameInputEl = $state<HTMLInputElement | null>(null);
  const selectedBoardIds = new SvelteSet<string>();

  // E.2 — autofocus + select the rename input when renamingBoardId flips so
  // the user can immediately type the new name. `bind:this` is reactive to
  // the conditional render, so we wait a tick for the input to mount.
  $effect(() => {
    if (!renamingBoardId) return;
    void (async () => {
      await tick();
      renameInputEl?.focus();
      renameInputEl?.select();
    })();
  });

  // Drag-to-reorder state
  let dragBoardId = $state<string | null>(null);
  let dragOverBoardId = $state<string | null>(null);

  // Keyboard reorder (Alt+ArrowUp/Down), the a11y equivalent of
  // the drag-to-reorder path above. `boardListEl` lets us refocus the moved
  // row after the keyed `{#each}` re-renders, mirroring TabBar's Alt+Arrow.
  let boardListEl = $state<HTMLDivElement | null>(null);

  const boards = $derived(() => {
    const project = vaultStore.project;
    if (!project) return [];
    if (!searchQuery) return project.boards;
    const q = searchQuery.toLowerCase();
    return project.boards.filter((b) => b.name.toLowerCase().includes(q));
  });

  const allBoardTypeLabels: Record<string, string> = {
    mindmap: 'Mind Map',
    kanban: 'Kanban',
    tasklist: 'Task List',
    document: 'Document',
  };

  const allBoardTypeIcons: Record<string, string> = {
    mindmap: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z',
    kanban: 'M3 3h18v18H3zM9 3v18M15 3v18',
    tasklist: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
  };

  // Document board type isn't directly creatable — use "Expand to Document" on a text tile.
  const { document: _docLabel, ...boardTypeLabels } = allBoardTypeLabels as Record<string, string>;
  const { document: _docIcon, ...boardTypeIcons } = allBoardTypeIcons as Record<string, string>;
  void _docLabel; void _docIcon;

  function handleBoardClick(board: Board, e: MouseEvent | KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Click: toggle selection without opening
      if (selectedBoardIds.has(board.id)) {
        selectedBoardIds.delete(board.id);
      } else {
        selectedBoardIds.add(board.id);
      }
      return;
    }

    // Alt+Click: open in a new split pane (right-side)
    if (e.altKey) {
      tabStore.open(board.id, board.name, board.type, board.emoji);
      const tab = tabStore.tabs.find((t) => t.boardId === board.id);
      if (tab && workspaceStore.leafCount < 3) {
        const activeLeaf = workspaceStore.activeLeaf;
        if (activeLeaf) workspaceStore.splitLeaf(activeLeaf.id, tab.id, 'right');
        else workspaceStore.splitRoot(tab.id, 'right');
      }
      uiStore.closeModal();
      return;
    }

    // If there are selected boards, open all selected + this one
    if (selectedBoardIds.size > 0) {
      const allIds = new SvelteSet(selectedBoardIds);
      allIds.add(board.id);
      const project = vaultStore.project;
      if (project) {
        for (const id of allIds) {
          const b = project.boards.find(bb => bb.id === id);
          if (b) tabStore.open(b.id, b.name, b.type, b.emoji);
        }
      }
      selectedBoardIds.clear();
      uiStore.closeModal();
      return;
    }

    // Normal click: open single board
    tabStore.open(board.id, board.name, board.type, board.emoji);
    uiStore.closeModal();
  }

  async function createBoard() {
    if (!vaultStore.project) return;
    // Belt-and-braces: the Create button is disabled when the name is in
    // use, but a stray Enter / keyboard activation could still slip in.
    if (newBoardNameError !== null) return;
    const name = newBoardName.trim() || suggestBoardName();

    // Single source of truth for default board shape per type.
    const board = boardRegistry[newBoardType].createDefault(
      createId(),
      name,
      vaultStore.project.settings,
    );

    // Persist via boardStore so the .board.json file is actually written
    // and the cache is registered. Pushing to project.boards directly
    // skips the disk write and silently breaks every subsequent save.
    const persisted = await boardStore.persistNewBoard(board);
    if (!persisted) {
      uiStore.toast('Failed to create board', 'error');
      return;
    }

    // Open it in a new tab
    tabStore.open(board.id, board.name, board.type);
    uiStore.closeModal();

    // Reset form
    showNewBoard = false;
    newBoardName = '';
    newBoardType = 'mindmap';
  }

  function startRename(board: Board) {
    renamingBoardId = board.id;
    renameValue = board.name;
  }

  async function commitRename() {
    if (!renamingBoardId || !renameValue || !vaultStore.project) {
      renamingBoardId = null;
      return;
    }
    const board = vaultStore.project.boards.find(b => b.id === renamingBoardId);
    if (board) {
      board.name = renameValue;
      vaultStore.markMetaDirty();
      // Update any open tab for this board
      const tab = tabStore.tabs.find(t => t.boardId === renamingBoardId);
      if (tab) tabStore.rename(tab.id, renameValue);
    }
    renamingBoardId = null;
  }

  function deleteBoard(boardId: string) {
    if (!vaultStore.project) return;
    const board = vaultStore.project.boards.find((b) => b.id === boardId);
    if (!board) return;
    uiStore.openConfirm({
      title: 'Delete board?',
      body: `"${board.name}" will be moved to Filo's trash. Its notes stay in the vault. Undo from the toast, or restore it from Settings → Trash.`,
      confirmLabel: 'Delete board',
      danger: true,
      // The store's deleteBoard moves the .board.json into Filo's trash, then
      // runs the shared post-removal cleanup (cache / project.boards /
      // viewport / open tabs / undo history) — the same path the
      // external-delete reconciler and the sidebar delete use, so the entry
      // points can't drift out of sync.
      onConfirm: () => { void boardStore.deleteBoard(boardId); },
    });
  }

  // ── Drag-to-Reorder ──
  function handleDragStart(boardId: string, e: DragEvent) {
    dragBoardId = boardId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', boardId);
    }
  }

  function handleDragOver(boardId: string, e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverBoardId = boardId;
  }

  function handleDragLeave() {
    dragOverBoardId = null;
  }

  function handleDrop(targetBoardId: string, e: DragEvent) {
    e.preventDefault();
    if (!dragBoardId || !vaultStore.project || dragBoardId === targetBoardId) {
      dragBoardId = null;
      dragOverBoardId = null;
      return;
    }

    const boards = vaultStore.project.boards;
    const fromIndex = boards.findIndex(b => b.id === dragBoardId);
    const toIndex = boards.findIndex(b => b.id === targetBoardId);
    if (fromIndex < 0 || toIndex < 0) return;

    const updated = [...boards];
    const [moved] = updated.splice(fromIndex, 1);
    if (!moved) return; // fromIndex >= 0 (checked above)
    updated.splice(toIndex, 0, moved);
    vaultStore.project.boards = updated;
    vaultStore.markMetaDirty();

    dragBoardId = null;
    dragOverBoardId = null;
  }

  function handleDragEnd() {
    dragBoardId = null;
    dragOverBoardId = null;
  }

  // ── Keyboard Reorder (Alt+ArrowUp / Alt+ArrowDown) ──
  // Swap the focused board with its visible neighbour, applied to the full
  // `project.boards` array by the pure helper so an active search filter can't
  // corrupt the global order. Refocus the moved row so the user can keep
  // pressing, exactly like TabBar's tab reorder.
  function moveBoard(boardId: string, delta: -1 | 1) {
    const project = vaultStore.project;
    if (!project) return;
    const updated = computeKeyboardReorder(project.boards, boards(), boardId, delta);
    if (!updated) return;
    project.boards = updated;
    vaultStore.markMetaDirty();
    requestAnimationFrame(() => {
      boardListEl?.querySelector<HTMLElement>(`[data-board-id="${boardId}"]`)?.focus();
    });
  }
</script>

<div class="browser-content">
  <div class="browser-header">
    <div class="search-bar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input
        class="search-input"
        type="text"
        placeholder="Search boards..."
        aria-label="Search boards"
        bind:value={searchQuery}
      />
    </div>
    <button class="new-board-btn" onclick={openNewBoardForm}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      New Board
    </button>
  </div>

  {#if showNewBoard}
    <div class="new-board-form">
      <input
        class="new-board-input"
        class:invalid={newBoardNameError !== null}
        type="text"
        placeholder="Board name..."
        bind:value={newBoardName}
        onkeydown={(e) => { if (e.key === 'Enter' && canCreateBoard) createBoard(); }}
        aria-invalid={newBoardNameError !== null}
        aria-describedby={newBoardNameError ? 'new-board-name-error' : undefined}
      />
      <select class="type-select" bind:value={newBoardType}>
        {#each Object.entries(boardTypeLabels) as [key, label] (key)}
          <option value={key}>{label}</option>
        {/each}
      </select>
      <button
        class="create-btn"
        onclick={createBoard}
        disabled={!canCreateBoard}
      >Create</button>
    </div>
    {#if newBoardNameError}
      <p class="new-board-error" id="new-board-name-error" role="alert">{newBoardNameError}</p>
    {/if}
  {/if}

  <div class="board-list" bind:this={boardListEl}>
    {#if boards().length === 0}
      <p class="empty-message">
        {searchQuery ? 'No boards match your search' : 'No boards yet. Create one to get started.'}
      </p>
    {:else}
      {#each boards() as board (board.id)}
        <div
          class="board-row"
          class:selected={selectedBoardIds.has(board.id)}
          class:drag-over={dragOverBoardId === board.id && dragBoardId !== board.id}
          class:dragging={dragBoardId === board.id}
          data-board-id={board.id}
          draggable="true"
          ondragstart={(e) => handleDragStart(board.id, e)}
          ondragover={(e) => handleDragOver(board.id, e)}
          ondragleave={handleDragLeave}
          ondrop={(e) => handleDrop(board.id, e)}
          ondragend={handleDragEnd}
          onclick={(e) => { if (renamingBoardId !== board.id) handleBoardClick(board, e); }}
          onkeydown={(e) => {
            if (renamingBoardId === board.id) return;
            // Alt+ArrowUp/Down reorders the focused row (keyboard a11y
            // equivalent of drag-reorder); Enter opens the board.
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              moveBoard(board.id, e.key === 'ArrowUp' ? -1 : 1);
            } else if (e.key === 'Enter') {
              handleBoardClick(board, e);
            }
          }}
          role="button"
          tabindex="0"
        >
          <svg class="board-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d={boardTypeIcons[board.type]}/>
          </svg>
          <div class="board-info">
            {#if renamingBoardId === board.id}
              <input
                class="board-rename-input"
                type="text"
                bind:this={renameInputEl}
                bind:value={renameValue}
                onclick={(e) => e.stopPropagation()}
                onblur={commitRename}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    // Stop the Enter from bubbling to the surrounding row's
                    // `onkeydown` (which would re-open the board on commit).
                    e.stopPropagation();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    renamingBoardId = null;
                  }
                }}
              />
            {:else}
              <span class="board-name">{board.emoji ? `${board.emoji} ` : ''}{board.name}</span>
            {/if}
            <span class="board-type">{boardTypeLabels[board.type]}</span>
          </div>
          <button
            class="board-action-btn board-rename"
            onclick={(e) => { e.stopPropagation(); startRename(board); }}
            title="Rename board"
            aria-label="Rename {board.name}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
          <button
            class="board-action-btn board-delete"
            onclick={(e) => { e.stopPropagation(); deleteBoard(board.id); }}
            title="Delete board"
            aria-label="Delete {board.name}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .browser-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .browser-header {
    display: flex;
    gap: 8px;
  }

  .search-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
  }

  .search-bar svg {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
  }

  .search-input:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .search-input:focus:not(:focus-visible) {
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .new-board-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--accent-primary);
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: var(--font-size-base);
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s ease;
  }

  .new-board-btn:hover {
    opacity: 0.9;
  }

  .new-board-form {
    display: flex;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-surface);
  }

  .new-board-input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
  }

  .new-board-input:focus {
    border-color: var(--ui-border-focus);
  }

  .new-board-input:focus:not(:focus-visible) {
    outline: none;
  }

  .new-board-input.invalid {
    border-color: var(--accent-danger, #d83b3b);
  }

  .new-board-error {
    margin: 4px 0 0 0;
    padding: 0 4px;
    color: var(--accent-danger, #d83b3b);
    font-size: 12px;
  }

  .type-select {
    padding: 6px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    cursor: pointer;
  }

  .create-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: var(--font-size-base);
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .create-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .create-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .board-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 720px;
    overflow-y: auto;
  }

  .board-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .board-row:hover {
    background: var(--ui-surface-hover);
  }

  .board-row.selected {
    background: var(--ui-surface-active);
    box-shadow: inset 0 0 0 1.5px var(--accent-primary);
  }

  .board-row.dragging {
    opacity: 0.4;
  }

  .board-row.drag-over {
    border-top: 2px solid var(--accent-primary);
  }

  .board-icon {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .board-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .board-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .board-type {
    font-size: 11px;
    color: var(--text-tertiary);
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--ui-surface-active);
    flex-shrink: 0;
  }

  .board-rename-input {
    flex: 1;
    padding: 2px 6px;
    border: 1px solid var(--ui-border-focus);
    border-radius: 3px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .board-rename-input:focus:not(:focus-visible) {
    outline: none;
  }

  .board-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
  }

  .board-row:hover .board-action-btn {
    opacity: 1;
  }

  .board-rename:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .board-delete:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .empty-message {
    text-align: center;
    padding: 24px;
    color: var(--text-tertiary);
    font-size: var(--font-size-base);
    margin: 0;
  }
</style>
