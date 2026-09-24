<script lang="ts">
  import { tabStore, type TabData } from '../../stores/tabs.svelte';
  import { workspaceStore } from '../../stores/workspace.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import EmojiPicker from '../shared/EmojiPicker.svelte';
  import { getContextMenuKeyPosition } from '../../lib/utils/contextMenuKey';

  interface Props {
    tab: TabData;
  }

  let { tab }: Props = $props();

  let isRenaming = $state(false);
  let renameValue = $state('');
  let renameInputEl = $state<HTMLInputElement | null>(null);
  let showEmojiPicker = $state(false);
  let emojiPickerPos = $state({ x: 0, y: 0 });
  let isDragOver = $state(false);

  const isActive = $derived(tabStore.activeTabId === tab.id);

  function activate() {
    tabStore.setActive(tab.id);
  }

  /** Alt+Click on a tab opens it in a new split pane (right-side by default). */
  function handleClick(e: MouseEvent) {
    if (e.altKey && workspaceStore.leafCount < 3) {
      e.preventDefault();
      e.stopPropagation();
      const activeLeaf = workspaceStore.activeLeaf;
      if (activeLeaf) {
        workspaceStore.splitLeaf(activeLeaf.id, tab.id, 'right');
      } else {
        workspaceStore.splitRoot(tab.id, 'right');
      }
      return;
    }
    activate();
  }

  function close(e: MouseEvent) {
    e.stopPropagation();
    void tabStore.close(tab.id);
  }

  // Middle-click closes the tab (matching browser/IDE
  // muscle memory). Closing routes through `tabStore.close` which
  // already runs the unsaved-changes confirm flow when the
  // active board still has pending writes, so this is safe to wire
  // unconditionally.
  function handleAuxClick(e: MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    void tabStore.close(tab.id);
  }

  function startRename() {
    isRenaming = true;
    renameValue = tab.name;
  }

  // Auto-focus + select-all when the rename input mounts,
  // mirroring VaultFileItem / KanbanColumn. The bind populates before this
  // effect runs because Svelte mounts the input synchronously after
  // isRenaming flips.
  $effect(() => {
    if (isRenaming && renameInputEl) {
      renameInputEl.focus();
      renameInputEl.select();
    }
  });

  function commitRename() {
    // Escape sets isRenaming=false, then the input unmounts and its blur
    // fires here — don't commit the rename the user just aborted. (Now that
    // the input auto-focuses, the Escape→blur path is reliably reachable.)
    if (!isRenaming) return;
    isRenaming = false;
    if (renameValue && renameValue !== tab.name) {
      tabStore.rename(tab.id, renameValue);
    }
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') isRenaming = false;
  }

  function handleDblClick() {
    startRename();
  }

  function handleDragStart(e: DragEvent) {
    const idx = tabStore.tabs.findIndex(t => t.id === tab.id);
    e.dataTransfer?.setData('text/plain', String(idx));
    e.dataTransfer?.setData('application/x-filo-tab-id', tab.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    isDragOver = true;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    const fromIdx = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10);
    const toIdx = tabStore.tabs.findIndex(t => t.id === tab.id);
    if (!isNaN(fromIdx) && fromIdx !== toIdx) {
      tabStore.reorder(fromIdx, toIdx);
    }
  }

  function openContextMenuAt(x: number, y: number, evX: number, evY: number) {
    const canSplit = workspaceStore.leafCount < 3;
    uiStore.showContextMenu(x, y, [
      { id: 'rename', label: 'Rename Board', icon: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z', action: startRename },
      { id: 'emoji', label: 'Set Board Emoji', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01', action: () => { showEmojiPicker = true; emojiPickerPos = { x: evX, y: evY }; } },
      { id: 'div-split', label: '', divider: true },
      { id: 'split-right', label: 'Split Right', icon: 'M3 3h18v18H3zM12 3v18', disabled: !canSplit, action: () => splitPane('right') },
      { id: 'split-down', label: 'Split Down', icon: 'M3 3h18v18H3zM3 12h18', disabled: !canSplit, action: () => splitPane('down') },
      { id: 'div1', label: '', divider: true },
      { id: 'close', label: 'Close Tab', icon: 'M18 6L6 18M6 6l12 12', action: () => { void tabStore.close(tab.id); } },
      { id: 'close-others', label: 'Close Other Tabs', icon: 'M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z', action: () => { void tabStore.closeOthers(tab.id); } },
    ], tab);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    openContextMenuAt(e.clientX, e.clientY, e.clientX, e.clientY);
  }

  function handleTabKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
      return;
    }
    const pos = getContextMenuKeyPosition(e, e.currentTarget as HTMLElement);
    if (pos) {
      e.preventDefault();
      e.stopPropagation();
      openContextMenuAt(pos.x, pos.y, pos.x, pos.y);
    }
  }

  function splitPane(direction: 'right' | 'down') {
    const activeLeaf = workspaceStore.activeLeaf;
    if (!activeLeaf) {
      workspaceStore.splitRoot(tab.id, direction === 'right' ? 'right' : 'bottom');
      return;
    }
    workspaceStore.splitLeaf(activeLeaf.id, tab.id, direction);
  }

  function selectEmoji(emoji: string) {
    showEmojiPicker = false;
    tabStore.setEmoji(tab.id, emoji);
    // Also update the board
    if (vaultStore.project) {
      const board = vaultStore.project.boards.find(b => b.id === tab.boardId);
      if (board) board.emoji = emoji;
      vaultStore.markMetaDirty();
    }
  }

  const boardTypeLabels: Record<string, string> = {
    mindmap: 'MM',
    kanban: 'KB',
    tasklist: 'TL',
    document: 'DC',
  };
</script>

<div
  class="tab"
  class:active={isActive}
  class:drag-over={isDragOver}
  onclick={handleClick}
  onauxclick={handleAuxClick}
  ondblclick={handleDblClick}
  oncontextmenu={handleContextMenu}
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={() => isDragOver = false}
  ondrop={handleDrop}
  ondragend={() => isDragOver = false}
  title="{tab.name} ({tab.boardType}) — Alt+Click to open in a split pane · Middle-click to close"
  role="tab"
  id={"tab-" + tab.id}
  aria-controls={"tabpanel-" + tab.id}
  tabindex={isActive ? 0 : -1}
  aria-selected={isActive}
  onkeydown={handleTabKeydown}
>
  {#if tab.emoji}
    <span class="tab-emoji">{tab.emoji}</span>
  {:else}
    <span class="tab-type">{boardTypeLabels[tab.boardType] || '??'}</span>
  {/if}

  {#if isRenaming}
    <input
      class="tab-rename"
      type="text"
      bind:this={renameInputEl}
      bind:value={renameValue}
      onblur={commitRename}
      onkeydown={handleRenameKeydown}
      aria-label="Rename {tab.name}"
    />
  {:else}
    <span class="tab-name">{tab.name}</span>
  {/if}

  <button
    class="tab-close"
    onclick={close}
    tabindex={isActive ? 0 : -1}
    title="Close tab"
    aria-label="Close {tab.name}"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  </button>
</div>

{#if showEmojiPicker}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="emoji-picker-overlay" onclick={() => showEmojiPicker = false} onkeydown={(e) => { if (e.key === 'Escape') showEmojiPicker = false; }}></div>
  <!-- Place the picker trigger at the cursor; EmojiPicker clamps + flips
       its own panel into the viewport. -->
  <div class="emoji-picker-float" style="left: {emojiPickerPos.x}px; top: {emojiPickerPos.y}px;">
    <EmojiPicker onselect={selectEmoji} />
  </div>
{/if}

<style>
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    height: calc(34px * var(--ui-tabbar-scale, 1));
    padding: 0 calc(10px * var(--ui-tabbar-scale, 1)) 0 calc(12px * var(--ui-tabbar-scale, 1));
    border: none;
    border-radius: 8px 8px 0 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    white-space: nowrap;
    max-width: 200px;
    transition: background-color 0.15s ease, color 0.15s ease;
    flex-shrink: 0;
    position: relative;
  }

  .tab:hover {
    background: var(--tab-hover-bg);
    color: var(--text-primary);
  }

  .tab.active {
    background: var(--tab-active-bg);
    color: var(--text-primary);
  }

  .tab.active::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 4px;
    right: 4px;
    height: 3px;
    background: var(--accent-primary);
    border-radius: 3px 3px 0 0;
  }

  .tab.drag-over {
    border-left: 2px solid var(--accent-primary);
  }

  .tab-emoji {
    font-size: 14px;
    line-height: 1;
    flex-shrink: 0;
  }

  .tab-type {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--ui-surface-active);
    color: var(--text-tertiary);
    flex-shrink: 0;
    line-height: 1.4;
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-rename {
    width: 100px;
    padding: 1px 4px;
    border: 1px solid var(--ui-border-focus);
    border-radius: 3px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .tab-rename:focus:not(:focus-visible) {
    outline: none;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(18px * var(--ui-tabbar-scale, 1));
    height: calc(18px * var(--ui-tabbar-scale, 1));
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease;
  }

  .tab:hover .tab-close,
  .tab.active .tab-close,
  .tab:focus-within .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .emoji-picker-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-context-menu-overlay);
  }

  .emoji-picker-float {
    position: fixed;
    z-index: var(--z-context-menu);
    animation: popIn 0.1s ease;
  }
</style>
