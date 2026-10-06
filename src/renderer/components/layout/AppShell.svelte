<script lang="ts">
  import VaultSidebar from '../sidebar/VaultSidebar.svelte';
  import FloatingVaultPanel from '../sidebar/FloatingVaultPanel.svelte';
  import GlobalToolbar from './GlobalToolbar.svelte';
  import TabBar from './TabBar.svelte';
  import HomeScreen from '../home/HomeScreen.svelte';
  import SplitPaneContainer from './SplitPaneContainer.svelte';
  import PaneDropOverlay from './PaneDropOverlay.svelte';
  import ContextMenu from '../shared/ContextMenu.svelte';
  import Toast from '../shared/Toast.svelte';
  import Modal from '../shared/Modal.svelte';
  import ConfirmDialog from '../shared/ConfirmDialog.svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import KeyboardShortcutsModal from '../settings/KeyboardShortcuts.svelte';
  import BoardBrowserModal from '../modals/BoardBrowser.svelte';
  import ProjectSettingsModal from '../modals/ProjectSettings.svelte';
  import RecoveryFilesModal from '../modals/RecoveryFiles.svelte';
  import OrphanCatcherModal from '../modals/OrphanCatcher.svelte';
  import TemplateBrowserModal from '../modals/TemplateBrowser.svelte';
  import SaveTemplateModal from '../modals/SaveTemplateModal.svelte';
  import RelinkTileModal from '../modals/RelinkTileModal.svelte';
  import SearchPanel from '../search/SearchPanel.svelte';
  import { searchStore } from '../../stores/search.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { workspaceStore } from '../../stores/workspace.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { selectionStore } from '../../stores/selection.svelte';
  import { canvasStore } from '../../stores/canvas.svelte';
  import { initKeyboardShortcuts, loadHotkeyOverrides } from '../../core/hotkeys';
  import { registerCommandWithShortcut } from '../../core/commandRegistry';
  import { createTile } from '../../stores/tiles.svelte';
  import { editTitleWhenShown } from '../../lib/boards/newTileTitle';
  import { releaseTextFocus } from '../../lib/boards/componentFlush';
  import { createNewNote, folderOfNote } from '../../lib/notes/newNote';
  import { mayLeaveRawView, rawTextUnsaved } from '../../lib/notes/rawViewLeave';
  import { untrack } from 'svelte';
  import { placeClear, tileRects, viewRect } from '../../lib/canvas/newTilePlacement';
  import { getActiveContentFolder } from '../../lib/vault/conventionPaths';
  import { toggleLockSelection } from '../../lib/boards/toggleLockSelection';
  import { requestDeleteSelected, selectableTileIds, toggleGroupSelection, type DeleteSelectionDeps } from '../../lib/mindmap/selectionActions';
  import { framesStore } from '../../stores/frames.svelte';
  import { isCanvasKeyBlocked } from '../../lib/mindmap/mindMapKeyboard';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { installLinkClickHandling } from '../../lib/editor/linkClicks';
  import { installTextMenu } from '../../lib/editor/textMenu';
  import { loadVaultFonts } from '../../lib/fonts/importedFonts';
  import { scheduleBoardModulePreload } from '../../lib/boards/boardModulePreload';
  import { allBoardModuleLoaders } from '../../core/boardModules';
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import { confirmDiscardSettings } from '../../lib/settings/confirmDiscardSettings';
  import { pickAndOpenVault } from '../../stores/vaultOpen';

  let showHome = $state(false);

  // Show home when no vault is open
  let shouldShowHome = $derived(vaultStore.project === null || showHome);

  // ── Board Browser focus trap (non-Modal slide-up panel) ──
  let boardBrowserPanelEl = $state<HTMLDivElement | null>(null);
  const isBoardBrowserOpen = $derived(uiStore.isModalOpen('board-browser'));
  // Set by BoardBrowser just before it closes itself after opening a board:
  // focus then belongs to that board, not to the button that opened the
  // browser.
  let boardOpenedFromBrowser = false;

  $effect(() => {
    const panel = boardBrowserPanelEl;
    if (!isBoardBrowserOpen || !panel) return;
    boardOpenedFromBrowser = false;
    const trap: FocusTrap = createFocusTrap(panel, {
      escapeDeactivates: false,
      // The backdrop's own click closes the browser; letting the trap
      // deactivate itself on outside clicks as well would double-deactivate.
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      setReturnFocus: (previous) => (boardOpenedFromBrowser ? false : previous),
      fallbackFocus: panel,
    });
    try {
      trap.activate();
    } catch {
      panel.focus();
    }
    return () => safeDeactivateTrap(trap, { name: 'AppShell' });
  });

  // ── Shortcuts that act on the Mind Map canvas ──
  //
  // `boardStore` still names the board a pane showed before it switched to a
  // Document tab, so the tab's own type is checked too. On Kanban and Task
  // List these keys belong to the board's own commands (Ctrl+N adds a card or
  // task, Ctrl+A selects its rows), which the global handler reaches only
  // when these are skipped.
  function onMindMap(): boolean {
    return tabStore.activeTab?.boardType === 'mindmap' && boardStore.boardType === 'mindmap';
  }

  const vaultIsOpen = (): boolean => vaultStore.project !== null;

  /** Focus is on a Mind Map canvas (or a tile on it), or on nothing at all. */
  function focusOnCanvasOrPage(): boolean {
    const active = document.activeElement;
    return !active || active === document.body || active.closest('.mindmap-board') !== null;
  }

  const deleteSelectionDeps: DeleteSelectionDeps = {
    board: boardStore,
    selection: selectionStore,
    vaultPath: () => (vaultStore.project === null ? null : vaultStore.path),
    hiddenTileIds: () => framesStore.hiddenTileIds,
  };

  function goHome() {
    showHome = true;
  }

  // A vault that opens replaces Home, however it was opened (Home's own
  // buttons, the vault menu, Ctrl+O).
  $effect(() => {
    void vaultStore.path;
    showHome = false;
  });

  // Hide home when tabs are opened
  $effect(() => {
    if (tabStore.count > 0) {
      showHome = false;
    }
  });

  // ── Sync pane tree with tabs ──
  // - Ensure a root leaf exists for the active tab when any tab is open.
  // - Drop leaves whose tab no longer exists.
  // - Mirror tab activation to the active pane's tab id.
  $effect(() => {
    const activeId = tabStore.activeTabId;
    if (!activeId) {
      workspaceStore.clearTree();
      return;
    }

    if (!workspaceStore.paneTree) {
      workspaceStore.ensureRoot(activeId);
      return;
    }

    const openTabIds = new Set(tabStore.tabs.map((t) => t.id));
    const leaves = workspaceStore.leaves;
    const staleLeafTabs = new Set(leaves.filter((l) => !openTabIds.has(l.tabId)).map((l) => l.tabId));
    if (staleLeafTabs.size > 0) {
      workspaceStore.dropLeavesForTabs(staleLeafTabs);
    }

    // If the active pane's tab was closed, or no active pane, fall back to
    // the first leaf that matches the active tab.
    const activePane = workspaceStore.activeLeaf;
    if (activePane && activePane.tabId !== activeId) {
      const existingLeaf = workspaceStore.findLeafByTab(activeId);
      if (existingLeaf) {
        workspaceStore.setActivePane(existingLeaf.id);
      } else if (rawLeave) {
        // The check running for this pane shows the latest tab when it ends.
      } else if (untrack(() => rawTextUnsaved(tabStore.tabs.find((t) => t.id === activePane.tabId)?.notePath))) {
        rawLeave = leaveRawTab(activePane.id, activePane.tabId);
      } else {
        workspaceStore.setLeafTab(activePane.id, activeId);
      }
    } else if (!activePane) {
      workspaceStore.ensureRoot(activeId);
    }
  });

  /** The raw-view check of a pane switching tabs, while it runs. Not reactive. */
  let rawLeave: Promise<void> | null = null;

  /**
   * The active pane is leaving a Document tab whose raw view holds unsaved
   * text: it is saved first, and if it can't be, the user chooses (as for a
   * close). The pane then shows whichever tab is active by then, or, on
   * Cancel, its tab is made active again.
   */
  async function leaveRawTab(paneId: string, leavingTabId: string): Promise<void> {
    const notePath = tabStore.tabs.find((t) => t.id === leavingTabId)?.notePath;
    let go = true;
    try {
      go = notePath ? await mayLeaveRawView(notePath) : true;
    } finally {
      rawLeave = null;
    }
    const pane = workspaceStore.leaves.find((l) => l.id === paneId);
    if (!pane || pane.tabId !== leavingTabId) return;
    const target = tabStore.activeTabId;
    if (!go) {
      if (tabStore.tabs.some((t) => t.id === leavingTabId)) tabStore.setActive(leavingTabId);
      return;
    }
    if (!target || target === leavingTabId) return;
    const shown = workspaceStore.findLeafByTab(target);
    if (shown) workspaceStore.setActivePane(shown.id);
    else workspaceStore.setLeafTab(paneId, target);
  }

  // Apply global font from project settings to the CSS custom property
  $effect(() => {
    const font = vaultStore.project?.settings?.general?.globalFont;
    if (font) {
      document.documentElement.style.setProperty('--font-system', font);
    }
  });

  // Register the open vault's imported fonts; a vault swap drops them again.
  $effect(() => {
    const path = vaultStore.path;
    if (path) void loadVaultFonts(path);
  });

  // Load every board type's code once the app is idle after a vault opens, so
  // the first open of a board doesn't show an empty pane while its chunk loads.
  // Keyed on a derived path, so a replaced project object doesn't restart it.
  const openVaultPath = $derived(vaultStore.project === null ? null : vaultStore.path);
  $effect(() => {
    if (!openVaultPath) return;
    return scheduleBoardModulePreload(allBoardModuleLoaders());
  });

  // Expose the Global Toolbar and Tab Bar heights as CSS custom properties
  // so position:fixed descendants (sidebar, side toolbars, minimap, board
  // browser panel) can anchor below / above the chrome. Heights derive from
  // the per-surface scale factor in Project Settings → General.
  $effect(() => {
    const general = vaultStore.project?.settings?.general;
    const toolbarScale = typeof general?.globalToolbarScale === 'number' ? general.globalToolbarScale : 1;
    const tabBarScale = typeof general?.tabBarScale === 'number' ? general.tabBarScale : 1;
    const toolbarHeight = Math.round(44 * toolbarScale);
    const tabBarHeight = Math.round(36 * tabBarScale);
    const root = document.documentElement;
    root.style.setProperty('--global-toolbar-height', `${toolbarHeight}px`);
    root.style.setProperty('--tabbar-height', `${tabBarHeight}px`);
  });

  // Initialize keyboard shortcuts on mount
  $effect(() => {
    initKeyboardShortcuts();

    const unsubs = [
      registerCommandWithShortcut({
        name: 'history:undo', label: 'Undo', description: 'Undo',
        binding: { key: 'z', ctrl: true },
        execute: () => historyStore.undo(),
      }),
      registerCommandWithShortcut({
        name: 'history:redo', label: 'Redo', description: 'Redo',
        binding: { key: 'y', ctrl: true },
        execute: () => historyStore.redo(),
      }),
      // A second name, so each chord can be rebound on its own.
      registerCommandWithShortcut({
        name: 'history:redo-alt', label: 'Redo (alternative)', description: 'Redo (alternative)',
        binding: { key: 'z', ctrl: true, shift: true },
        execute: () => historyStore.redo(),
      }),

      // ── Vault and Settings ──
      //
      // There is no native menu, so these are the keyboard way in. Opening
      // and closing go through the vault store's own open / close, which save
      // first and ask before leaving anything unsaved behind.
      registerCommandWithShortcut({
        name: 'vault:open', label: 'Open Vault', description: 'Open Vault',
        binding: { key: 'o', ctrl: true },
        allowInEditor: true,
        execute: async () => { await pickAndOpenVault(); },
      }),
      registerCommandWithShortcut({
        name: 'vault:close', label: 'Close Vault', description: 'Close Vault',
        binding: { key: 'w', ctrl: true, shift: true },
        allowInEditor: true,
        enabled: vaultIsOpen,
        execute: async () => { await vaultStore.closeVault(); },
      }),
      registerCommandWithShortcut({
        name: 'settings:open', label: 'Open Settings', description: 'Open Settings',
        binding: { key: ',', ctrl: true },
        allowInEditor: true,
        enabled: vaultIsOpen,
        execute: () => uiStore.openModal('project-settings'),
      }),
      registerCommandWithShortcut({
        name: 'template:open', label: 'Insert Template', description: 'Insert Template',
        binding: { key: 't', ctrl: true },
        // A layout template inserts tiles on the canvas.
        enabled: onMindMap,
        execute: () => uiStore.openModal('template-picker'),
      }),
      registerCommandWithShortcut({
        name: 'tag:open-browser', label: 'Open Tags Browser', description: 'Open Tags Browser',
        binding: { key: 't', ctrl: true, shift: true },
        execute: () => uiStore.openModal('tags-browser'),
      }),
      registerCommandWithShortcut({
        name: 'vault:save', label: 'Save', description: 'Save',
        binding: { key: 's', ctrl: true },
        // Fires even when focus is in a TipTap editor.
        // Without this, Ctrl+S inside a TextTile or DocumentEditor is
        // swallowed by the contenteditable guard in hotkeys.ts:78, so the
        // user's manual save attempt silently does nothing. The save path
        // is editor-safe: flushAllMarkdownWriters drains the in-editor
        // debounce timer before the .board.json / .filo/ flush.
        allowInEditor: true,
        // Saving acts on nothing the dialog hides.
        allowInDialog: true,
        // A task title or notes box being typed in is saved too (its
        // component flush hands the text over); the Raw view takes the key itself.
        allowInField: true,
        execute: () => {
          void (async () => {
            const ok = await vaultStore.save();
            if (!ok) {
              // Per-file toasts from trackComponentWrite already enumerate
              // which writes failed; this one is the single "Ctrl+S didn't
              // actually save" signal that ties them together.
              uiStore.toast('Save failed — check the error toasts above', 'error');
            }
          })();
        },
      }),
      registerCommandWithShortcut({
        name: 'tile:group', label: 'Group / Ungroup', description: 'Group / Ungroup',
        binding: { key: 'g', ctrl: true },
        enabled: onMindMap,
        execute: () => toggleGroupSelection(boardStore, [...selectionStore.selectedIds]),
      }),
      registerCommandWithShortcut({
        name: 'app:cancel', label: 'Cancel / Close', description: 'Cancel / Close',
        binding: { key: 'Escape' },
        // Layering-aware: close only the topmost dismissable layer
        // (confirm dialog → modal → context menu) so a stacked confirm
        // doesn't take the modal beneath it down with it. With none open
        // the key is left unprevented, for the board's own Escape and,
        // after them, the Search panel's.
        execute: () => uiStore.cancelTopLayer() !== null,
      }),

      // ── New tile at viewport center ──
      registerCommandWithShortcut({
        name: 'tile:new', label: 'New Tile', description: 'New Tile',
        binding: { key: 'n', ctrl: true },
        enabled: onMindMap,
        execute: () => {
          if (!boardStore.current) return;
          const vp = canvasStore.viewportRect;
          const tile = createTile('text', { x: 0, y: 0 }, boardStore.current.id);
          // In the middle of the view, or stepped clear of the tiles already there.
          tile.position = {
            ...tile.position,
            ...placeClear(
              { x: vp.left + vp.width / 2 - tile.size.width / 2, y: vp.top + vp.height / 2 - tile.size.height / 2 },
              tile.size,
              tileRects(boardStore.tiles),
              viewRect(vp),
            ),
          };
          boardStore.addTileWithHistory(tile);
          selectionStore.select(tile.id);
          editTitleWhenShown(tile.id);
        },
      }),

      // ── New note beside the one a Document tab shows ──
      // Ctrl+N is each board's own "new" (tile, card, task); in a Document
      // tab it makes a note, in the same folder. It works while typing in the
      // note, as the boards' do from their canvas.
      registerCommandWithShortcut({
        name: 'note:new', label: 'New Note', description: 'New Note (in a Document tab)',
        binding: { key: 'n', ctrl: true },
        allowInEditor: true,
        enabled: () => tabStore.activeTab?.boardType === 'document' && vaultIsOpen(),
        execute: () => {
          const notePath = tabStore.activeTab?.notePath;
          void createNewNote(notePath ? folderOfNote(notePath) : getActiveContentFolder(null));
        },
      }),

      // ── Select all tiles on current board ──
      registerCommandWithShortcut({
        name: 'tile:select-all', label: 'Select All', description: 'Select All',
        binding: { key: 'a', ctrl: true },
        enabled: onMindMap,
        execute: () => {
          if (!boardStore.current) return;
          selectionStore.selectMultiple(selectableTileIds(boardStore.tiles, framesStore.hiddenTileIds));
        },
      }),

      // ── Delete selected tiles ──
      registerCommandWithShortcut({
        name: 'tile:delete', label: 'Remove Selected', description: 'Remove Selected',
        binding: { key: 'Delete' },
        // Not while a dialog or menu is open over the board, nor from the
        // sidebar or a toolbar: only with focus on the canvas or on the page.
        enabled: () => onMindMap() && focusOnCanvasOrPage() && !isCanvasKeyBlocked('Delete', document.activeElement),
        execute: () => requestDeleteSelected(deleteSelectionDeps),
      }),

      // ── Lock / Unlock selected tiles ──
      registerCommandWithShortcut({
        name: 'tile:toggle-lock', label: 'Lock / Unlock Selected', description: 'Lock / Unlock Selected',
        binding: { key: 'l', ctrl: true },
        // Kanban and Task List keep their lock on the card or row itself.
        enabled: onMindMap,
        execute: () => { toggleLockSelection(boardStore, selectionStore.selectedIds); },
      }),

      // ── Insert Link in active editor ──
      registerCommandWithShortcut({
        name: 'editor:insert-link', label: 'Insert Link', description: 'Insert Link',
        binding: { key: 'k', ctrl: true },
        allowInEditor: true,
        execute: () => {
          if (!tiptapToolbar.requestInsertLink()) {
            uiStore.toast('Click into a text tile or document first', 'info');
          }
        },
      }),

      // ── Vault-wide Search (Ctrl+Shift+F) ──
      registerCommandWithShortcut({
        name: 'vault:search',
        label: 'Search Vault',
        description: 'Open the vault-wide Search panel',
        binding: { key: 'f', ctrl: true, shift: true },
        // Fires from inside a TipTap editor or a text field so users editing
        // a tile can hop into Search without breaking focus. It changes no
        // text being typed.
        allowInEditor: true,
        allowInField: true,
        execute: () => {
          if (vaultStore.project === null) return;
          searchStore.openPanel('find');
        },
      }),

      // ── Tab bar a11y ──
      //
      // Ctrl+W closes the active tab; Ctrl+Tab cycles forward, Ctrl+Shift+Tab
      // cycles backward. All three work while typing, as in a browser: the
      // edit ends first (`releaseTextFocus`), as a click on a tab ends it.
      registerCommandWithShortcut({
        name: 'tab:close',
        label: 'Close Tab',
        description: 'Close the active tab',
        binding: { key: 'w', ctrl: true },
        allowInEditor: true,
        allowInField: true,
        execute: () => {
          const activeId = tabStore.activeTabId;
          if (!activeId) return;
          releaseTextFocus();
          // A title that blur committed is written by a command: the close
          // waits for it to queue its write, so the close's own save takes
          // it (else the close finds it unsaved and asks).
          void historyStore.whenChainSettled().then(() => tabStore.close(activeId));
        },
      }),
      registerCommandWithShortcut({
        name: 'tab:next',
        label: 'Next Tab',
        description: 'Cycle to the next open tab',
        binding: { key: 'Tab', ctrl: true },
        allowInEditor: true,
        allowInField: true,
        execute: () => {
          if (tabStore.count < 2) return;
          releaseTextFocus();
          const ids = tabStore.tabs.map((t) => t.id);
          const cur = tabStore.activeTabId;
          if (!cur) return;
          const idx = ids.indexOf(cur);
          if (idx < 0) return;
          const nextId = ids[(idx + 1) % ids.length];
          if (nextId) tabStore.setActive(nextId);
        },
      }),
      registerCommandWithShortcut({
        name: 'tab:prev',
        label: 'Previous Tab',
        description: 'Cycle to the previous open tab',
        binding: { key: 'Tab', ctrl: true, shift: true },
        allowInEditor: true,
        allowInField: true,
        execute: () => {
          if (tabStore.count < 2) return;
          releaseTextFocus();
          const ids = tabStore.tabs.map((t) => t.id);
          const cur = tabStore.activeTabId;
          if (!cur) return;
          const idx = ids.indexOf(cur);
          if (idx < 0) return;
          const prevId = ids[(idx - 1 + ids.length) % ids.length];
          if (prevId) tabStore.setActive(prevId);
        },
      }),
    ];

    return () => unsubs.forEach((u) => u());
  });

  // Load hotkey overrides from .filo/hotkeys.json each time a vault is opened.
  // Re-applies bindings to all currently registered shortcuts.
  $effect(() => {
    const path = vaultStore.path;
    if (!path) return;
    void loadHotkeyOverrides(path);
  });

  // Link clicks: plain click edits inside a note being edited, Ctrl+click
  // opens; everywhere else a click opens (see linkClicks.ts).
  $effect(() => installLinkClickHandling());

  // The right-click menu on text: main asks whether a link can go at the
  // caret, and its Insert Link opens the popup here.
  $effect(() => installTextMenu());

  // In a narrow window the docked sidebar pushes the workspace aside, so it
  // never covers the start of a note's lines (uiStore.sidebarPushesWorkspace).
  $effect(() => uiStore.trackWindowWidth());
  let dockedSidebarShown = $derived(vaultStore.project !== null && !shouldShowHome && !uiStore.sidebarFloating);

  // Vaults are opened via folder picker from the HomeScreen.
  // No .filo file association handling needed.

  // Prevent native context menu on the app — except inside editable text,
  // where main shows its text menu (spelling, Cut, Copy, Paste, Select All,
  // and Insert Link in a note: main/utils/textMenu.ts).
  function handleContextMenu(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="app-shell" oncontextmenu={handleContextMenu}>
  <a class="skip-link" href="#main-workspace">Skip to content</a>
  <GlobalToolbar onGoHome={goHome} showSidebarToggle={!shouldShowHome} />

  <div class="app-body">
    {#if dockedSidebarShown}
      <VaultSidebar open={uiStore.sidebarOpen} />
    {/if}

    <main
      id="main-workspace"
      class="workspace"
      aria-label="Board workspace"
      style:margin-left={dockedSidebarShown && uiStore.sidebarPushesWorkspace ? `${uiStore.sidebarWidth}px` : null}
    >
      {#if shouldShowHome}
        <HomeScreen onReturnToVault={() => showHome = false} />
      {:else if tabStore.count > 0}
        <div class="board-viewport">
          {#if workspaceStore.paneTree}
            <SplitPaneContainer node={workspaceStore.paneTree} />
          {/if}
          <PaneDropOverlay />
        </div>
      {:else if vaultStore.project !== null}
        <div class="empty-workspace">
          <button class="empty-workspace-btn" onclick={() => uiStore.openModal('board-browser')}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="12" y1="8" x2="12" y2="16"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
            <span>Create or open a board</span>
          </button>
        </div>
      {/if}
    </main>
  </div>

  {#if vaultStore.project !== null && !shouldShowHome}
    <TabBar />
  {/if}

  <!--
    Floating vault panel — lives outside `.app-body` (and outside the
    tab/board content) so its position is anchored to the viewport
    rather than the workspace area, and it persists across tab/board
    switches by virtue of being a sibling of the workspace. Hide Vault
    removes it; the toolbar's sidebar toggle brings it back.
  -->
  {#if vaultStore.project !== null && !shouldShowHome && uiStore.sidebarFloating && uiStore.sidebarOpen}
    <FloatingVaultPanel />
  {/if}

  <!-- Global overlays -->
  <ContextMenu />
  <Toast />
  <ConfirmDialog />

  <!--
    Vault-wide Search panel (Ctrl+Shift+F). Sibling of the workspace so it
    overlays whichever pane is active and persists across tab switches. The
    panel handles its own open/close visibility via `searchStore.open`.
  -->
  {#if vaultStore.project !== null && !shouldShowHome && searchStore.open}
    <SearchPanel />
  {/if}

  <!-- Modals -->
  <!--
    Gate the keyboard-shortcuts modal mount on the open-modal id so its DOM
    and the lazy KeyboardShortcutsModal contents only exist while the panel
    is visible, like every other modal in this block.
  -->
  {#if uiStore.isModalOpen('keyboard-shortcuts')}
    <Modal id="keyboard-shortcuts" title="Help" width="520px">
      <KeyboardShortcutsModal />
    </Modal>
  {/if}

  <!--
    Board Browser: slide-up panel above TabBar.
    A transparent click-catcher backdrop sits BEHIND the panel as an empty
    sibling, never its parent: a dialog inside an aria-hidden ancestor
    hides its focused controls from assistive tech. A click on the backdrop
    closes the browser. Clicks inside the panel bubble normally so buttons,
    the inline rename input, and BoardBrowser's own handlers keep working —
    the in-flight rename's onblur commit still fires when the panel
    unmounts, so a partial rename isn't lost.
  -->
  {#if uiStore.isModalOpen('board-browser')}
    <div
      class="board-browser-backdrop"
      onclick={() => uiStore.closeModal()}
      role="presentation"
    ></div>
    <div
      class="board-browser-panel"
      bind:this={boardBrowserPanelEl}
      role="dialog"
      aria-modal="true"
      aria-label="Board Browser"
      tabindex="-1"
      onkeydown={(e) => { if (e.key === 'Escape') uiStore.closeModal(); }}
    >
      <div class="board-browser-panel-header">
        <h2 class="board-browser-panel-title">Board Browser</h2>
        <button
          class="board-browser-panel-close"
          onclick={() => uiStore.closeModal()}
          title="Close"
          aria-label="Close Board Browser"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="board-browser-panel-body">
        <BoardBrowserModal onBoardOpened={() => { boardOpenedFromBrowser = true; }} />
      </div>
    </div>
  {/if}

  <!--
    Tags Browser modal — TagsBrowser owns its own <Modal id="tags-browser">,
    so we only need to gate the lazy import on the modal being open. Wrapping
    in another <Modal> here would mount two <dialog showModal()> for the same
    id with conflicting widths.
  -->
  {#if uiStore.isModalOpen('tags-browser')}
    {#await import('../tags/TagsBrowser.svelte') then module}
      <module.default />
    {/await}
  {/if}

  {#if uiStore.isModalOpen('project-settings')}
    <Modal
      id="project-settings"
      title="Settings"
      width="900px"
      maxHeight="85vh"
      flush
      isolateShortcuts
      beforeClose={() => confirmDiscardSettings(pendingSettingsStore, uiStore)}
    >
      <ProjectSettingsModal />
    </Modal>
  {/if}

  {#if uiStore.isModalOpen('recovery-files')}
    <!-- A bypassed close (Esc / X / backdrop) must still UN-PARK the recovery
         sequencer, or steps 2–4 (tag-rewrite Resume/Discard, rename-cascade
         retry, snapshot listing) are skipped for the session.
         But a bypassed close is NOT an acknowledgement, so it
         routes through `bypassRecoveryModalClose()` (un-park only) rather than
         `acknowledgeRecovery()`: the `.filo/.dirty` sentinel + pending paths
         are preserved so recovery RE-QUEUES next launch. Only the explicit
         Dismiss button (RecoveryFiles.svelte → acknowledgeRecovery) destroys
         the breadcrumb. -->
    <Modal
      id="recovery-files"
      title="Changes that may not have been saved"
      width="520px"
      beforeClose={() => {
        vaultStore.bypassRecoveryModalClose();
        return true;
      }}
    >
      <RecoveryFilesModal />
    </Modal>
  {/if}

  {#if uiStore.isModalOpen('orphan-catcher')}
    <Modal id="orphan-catcher" title="Orphan Catcher" width="520px">
      <OrphanCatcherModal />
    </Modal>
  {/if}

  {#if uiStore.isModalOpen('template-picker')}
    <TemplateBrowserModal />
  {/if}

  {#if uiStore.isModalOpen('save-template')}
    <SaveTemplateModal />
  {/if}

  {#if uiStore.isModalOpen('relink-tile')}
    <RelinkTileModal />
  {/if}
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-family: var(--font-system);
    overflow: hidden;
  }

  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .workspace {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
    background: var(--ui-bg);
  }

  /* ── Board viewport ── */
  .board-viewport {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--canvas-bg);
  }


  /* ── Empty workspace ── */
  .empty-workspace {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .empty-workspace-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 32px;
    border: 1px dashed var(--ui-border);
    border-radius: 12px;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 14px;
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .empty-workspace-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
    border-color: var(--accent-primary);
  }


  /* ── Board Browser slide-up panel ── */
  /*
   * Full-viewport invisible click-catcher that closes the Board Browser on
   * outside-click. No background colour so the rest of the app stays visible.
   */
  .board-browser-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal-backdrop);
    background: transparent;
  }

  .board-browser-panel {
    position: fixed;
    bottom: var(--tabbar-height, 36px);
    left: 0;
    width: 560px;
    /* Paint one layer above the click-catcher backdrop (--z-modal-backdrop,
       3000) rather than relying on DOM order; --z-modal (3001) makes the
       stacking explicit. */
    z-index: var(--z-modal);
    max-height: 80vh;
    background: var(--modal-bg);
    border-top: 1px solid var(--ui-border);
    border-right: 1px solid var(--ui-border);
    border-top-right-radius: 8px;
    box-shadow: 2px -4px 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    animation: boardBrowserSlideUp 0.2s ease;
  }

  @keyframes boardBrowserSlideUp {
    from {
      transform: translateY(100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .board-browser-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--ui-border);
    flex-shrink: 0;
  }

  .board-browser-panel-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  .board-browser-panel-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .board-browser-panel-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .board-browser-panel-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
  }

</style>
