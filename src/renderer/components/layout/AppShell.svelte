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
  import { linksStore } from '../../stores/links.svelte';
  import { isFiloLink } from '../../schema/link';
  import { canvasStore } from '../../stores/canvas.svelte';
  import { documentStore } from '../../stores/document.svelte';
  import { initKeyboardShortcuts, loadHotkeyOverrides } from '../../core/hotkeys';
  import { registerCommandWithShortcut } from '../../core/commandRegistry';
  import { createTile } from '../../stores/tiles.svelte';
  import { type TextTile, type Tile } from '../../schema/index';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { asSafeOpenExternal } from '../../../shared/untrusted';
  import { normalizePath } from '../../lib/utils/path';
  import { buildDeleteSnapshots, TILE_DELETE_SNAPSHOT_MAX_BYTES } from '../../lib/canvas/deleteTileSnapshots';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import {
    PendingWritesFailedError,
    withDrainedWrites,
  } from '../../lib/vault/vaultOperations';
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import { confirmDiscardSettings } from '../../lib/settings/confirmDiscardSettings';

  let showHome = $state(false);

  // Show home when there's no project
  let shouldShowHome = $derived(vaultStore.project === null || showHome);

  // ── Board Browser focus trap (non-Modal slide-up panel) ──
  let boardBrowserPanelEl = $state<HTMLDivElement | null>(null);
  let boardBrowserTrap: FocusTrap | null = null;
  const isBoardBrowserOpen = $derived(uiStore.isModalOpen('board-browser'));

  $effect(() => {
    if (isBoardBrowserOpen && boardBrowserPanelEl) {
      boardBrowserTrap = createFocusTrap(boardBrowserPanelEl, {
        escapeDeactivates: false,
        clickOutsideDeactivates: true,
        allowOutsideClick: true,
        returnFocusOnDeactivate: true,
      });
      try {
        boardBrowserTrap.activate();
      } catch {
        boardBrowserPanelEl.focus();
      }
      // Snapshot the panel reference at activation time so the teardown can
      // tell whether the panel is still in the DOM when it runs. Reading
      // the live `boardBrowserPanelEl` from the cleanup is unreliable —
      // bind:this may have already nulled it by the time we run.
      const trappedPanel = boardBrowserPanelEl;
      return () => {
        // C8 — see lib/utils/focusTrapSafe.ts. The helper short-circuits on
        // a detached host (a click inside the panel that both closes the
        // browser AND opens a board unmounts the panel before this teardown
        // runs; focus-trap's updateTabbableNodes would otherwise throw and
        // freeze Svelte 5's flush).
        safeDeactivateTrap(boardBrowserTrap, { host: trappedPanel, name: 'AppShell' });
        boardBrowserTrap = null;
      };
    }
  });

  // ── Multi-tile delete confirmation ──
  //
  // True if any selected tile has an associated vault file. In V7 every text
  // tile creates a backing `${title}.md`, so contentId presence is the signal.
  function selectionHasVaultFiles(): boolean {
    if (vaultStore.project === null) return false;
    for (const id of selectionStore.selectedIds) {
      const tile = boardStore.getTile(id);
      if (!tile || tile.type !== 'text') continue;
      if ((tile as TextTile).contentId) return true;
    }
    return false;
  }

  function requestDeleteSelected() {
    // Phase C / C.4 — Delete now applies to connections as well as tiles.
    // Connection deletes are undoable and not file-backed, so they don't
    // need the heavyweight tile-confirm gate. We do three things in turn:
    //
    //   1. If any connections are selected, fire DeleteConnectionCommand
    //      for each (no confirm — matches the context-menu "Delete
    //      Connection" entry which has never had one).
    //   2. If any tiles are also selected, fall through to the existing
    //      tile-confirm gate (which may surface the file-delete checkbox).
    //   3. If only connections were selected, we're done; clear selection.
    const connIds = [...selectionStore.selectedConnectionIds];
    if (connIds.length > 0) {
      for (const id of connIds) {
        boardStore.removeConnectionWithHistory(id);
      }
      selectionStore.clearConnections();
    }
    if (selectionStore.selectedIds.size === 0) return;
    const count = selectionStore.selectedIds.size;
    const showFileOption = selectionHasVaultFiles();
    uiStore.openConfirm({
      title: 'Delete Tiles',
      body: `Are you sure you want to delete ${count} tile${count !== 1 ? 's' : ''}?`,
      confirmLabel: 'Delete',
      danger: true,
      extraOption: showFileOption
        ? {
            label: 'Delete associated files from vault as well?',
            hint: 'Ctrl+Z will restore both the tile and its file content. Files over 25MB cannot be restored.',
            initial: false,
          }
        : undefined,
      onConfirm: (deleteWithFile) => { void performDeleteSelected(deleteWithFile === true); },
    });
  }

  // Snapshot cap — backing files larger than this aren't read into memory
  // for the undo snapshot. Restoring a 25 MB+ markdown via Ctrl+Z is rare and
  // copying it twice (delete-time read + undo-time write) on the hot path
  // would spike memory. Skipped files are surfaced via toast so the user
  // knows their delete is one-way.
  async function performDeleteSelected(deleteWithFile: boolean) {
    const selectedIds = [...selectionStore.selectedIds];

    // Phase R2 — when capturing undo snapshots, the pre-IPC `.md` reads
    // must reflect the post-flush disk state, NOT the pre-flush editor
    // body. Without the drain, a 300ms-debounced keystroke that landed
    // after the user clicked "Delete with files" would still be sitting
    // in-memory; the snapshot would capture the pre-keystroke disk
    // bytes, then DeleteTilesCommand.executeFileDeletes would delete
    // the file, and Ctrl+Z would restore the stale (pre-keystroke)
    // snapshot — silently dropping the keystroke.
    //
    // Wrap the snapshot build + command queue in `withDrainedWrites` so
    // the entire sequence runs against a known-quiescent disk.
    try {
      await withDrainedWrites(async () => {
        let fileSnapshots: { rel: string; content: string }[] | undefined;
        let vaultRoot: string | undefined;
        if (deleteWithFile && selectionHasVaultFiles()) {
          vaultRoot = normalizePath(vaultStore.path);
          // Pre-read each backing .md so undo can write it back. Reads run before
          // the placement-removal command so any read failure (file already gone,
          // ENOENT race) drops out cleanly without leaving a half-restored undo
          // snapshot. The file is also deleted by the command itself, not here —
          // see DeleteTilesCommand.execute(). Also unload the document on the way
          // through so a sibling editor doesn't keep a stale body in memory.
          const tilesToRead = selectedIds
            .map((id) => boardStore.getTile(id))
            .filter((t): t is NonNullable<typeof t> => !!t);
          for (const tile of tilesToRead) {
            if (tile.type === 'text') {
              const textTile = tile as TextTile;
              const docId = textTile.contentId || tile.id;
              documentStore.unloadDocument(docId);
            }
          }
          const result = await buildDeleteSnapshots(tilesToRead, vaultRoot);
          fileSnapshots = result.fileSnapshots;
          if (result.oversizedPaths.length > 0) {
            const sample = result.oversizedPaths.slice(0, 3).join(', ');
            const more = result.oversizedPaths.length > 3 ? `, +${result.oversizedPaths.length - 3} more` : '';
            uiStore.toast(
              `${result.oversizedPaths.length} file(s) over ${TILE_DELETE_SNAPSHOT_MAX_BYTES / (1024 * 1024)}MB were deleted without an undo snapshot (${sample}${more}). Ctrl+Z will restore the tile but not the file body.`,
              'warning',
              7000,
            );
          }
        }
        boardStore.removeTilesWithHistory(selectedIds, { fileSnapshots, vaultRoot });
        selectionStore.clear();
      });
    } catch (err) {
      if (err instanceof PendingWritesFailedError) {
        // Drain already pushed its own toast; bail without removing
        // anything so the user can fix the save errors and retry.
        return;
      }
      throw err;
    }
  }

  function goHome() {
    showHome = true;
  }

  // When a project is loaded, hide home
  $effect(() => {
    if (vaultStore.project !== null && showHome) {
      // Keep showing home until user explicitly navigates away
    }
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
      } else {
        workspaceStore.setLeafTab(activePane.id, activeId);
      }
    } else if (!activePane) {
      workspaceStore.ensureRoot(activeId);
    }
  });

  // Apply global font from project settings to the CSS custom property
  $effect(() => {
    const font = vaultStore.project?.settings?.general?.globalFont;
    if (font) {
      document.documentElement.style.setProperty('--font-system', font);
    }
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
      registerCommandWithShortcut({
        name: 'template:open', label: 'Insert Template', description: 'Insert Template',
        binding: { key: 't', ctrl: true },
        execute: () => uiStore.openModal('template-picker'),
      }),
      registerCommandWithShortcut({
        name: 'tag:open-browser', label: 'Open Tags Browser', description: 'Open Tags Browser',
        binding: { key: 't', ctrl: true, shift: true },
        execute: () => uiStore.openModal('tags-browser'),
      }),
      registerCommandWithShortcut({
        name: 'vault:save', label: 'Save Project', description: 'Save Project',
        binding: { key: 's', ctrl: true },
        // Phase 31 A1.1 — fires even when focus is in a TipTap editor.
        // Without this, Ctrl+S inside a TextTile or DocumentEditor is
        // swallowed by the contenteditable guard in hotkeys.ts:78, so the
        // user's manual save attempt silently does nothing. The save path
        // is editor-safe: flushAllMarkdownWriters drains the in-editor
        // debounce timer before the .board.json / .filo/ flush.
        allowInEditor: true,
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
        execute: () => {
          const ids = [...selectionStore.selectedIds];
          if (ids.length < 2) return;
          const group = boardStore.getGroupForTile(ids[0]);
          const allInSameGroup = group && ids.every(id => boardStore.getGroupForTile(id)?.id === group.id);
          const groupsBefore = [...boardStore.groups];
          if (allInSameGroup) {
            boardStore.ungroupTilesWithHistory(ids, groupsBefore);
            uiStore.toast('Tiles ungrouped', 'info', 1500);
          } else {
            boardStore.groupTilesWithHistory(ids, groupsBefore);
            uiStore.toast('Tiles grouped', 'info', 1500);
          }
        },
      }),
      registerCommandWithShortcut({
        name: 'app:cancel', label: 'Cancel / Close', description: 'Cancel / Close',
        binding: { key: 'Escape' },
        execute: () => {
          // Layering-aware (H1): close only the topmost dismissable layer
          // (confirm dialog → modal → context menu) so a stacked confirm
          // doesn't take the modal beneath it down with it.
          uiStore.cancelTopLayer();
        },
      }),

      // ── New tile at viewport center ──
      registerCommandWithShortcut({
        name: 'tile:new', label: 'New Tile', description: 'New Tile',
        binding: { key: 'n', ctrl: true },
        execute: () => {
          if (!boardStore.current) return;
          const vp = canvasStore.viewportRect;
          const jitterX = (Math.random() - 0.5) * 100;
          const jitterY = (Math.random() - 0.5) * 100;
          const tile = createTile('text', {
            x: vp.left + vp.width / 2 - 150 + jitterX,
            y: vp.top + vp.height / 2 - 100 + jitterY,
          }, boardStore.current.id);
          boardStore.addTileWithHistory(tile);
          selectionStore.select(tile.id);
        },
      }),

      // ── Select all tiles on current board ──
      registerCommandWithShortcut({
        name: 'tile:select-all', label: 'Select All', description: 'Select All',
        binding: { key: 'a', ctrl: true },
        execute: () => {
          if (!boardStore.current) return;
          const allIds = Object.values(boardStore.tiles).map(t => t.id);
          selectionStore.selectMultiple(allIds);
        },
      }),

      // ── Delete selected tiles ──
      registerCommandWithShortcut({
        name: 'tile:delete', label: 'Remove Selected', description: 'Remove Selected',
        binding: { key: 'Delete' },
        execute: () => requestDeleteSelected(),
      }),

      // ── Lock / Unlock selected tiles ──
      registerCommandWithShortcut({
        name: 'tile:toggle-lock', label: 'Lock / Unlock Selected', description: 'Lock / Unlock Selected',
        binding: { key: 'l', ctrl: true },
        execute: () => {
          const ids = [...selectionStore.selectedIds];
          if (ids.length === 0) return;
          const tiles = ids.map(id => boardStore.getTile(id)).filter(Boolean) as Tile[];
          if (tiles.length === 0) return;
          const targetLocked = tiles.some(t => !t.locked);
          const previousStates = new Map<string, boolean>(tiles.map(t => [t.id, t.locked === true]));
          boardStore.setTilesLockedWithHistory(previousStates, targetLocked);
          uiStore.toast(targetLocked ? 'Tiles locked' : 'Tiles unlocked', 'info', 1500);
        },
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

      // ── Sprint E — Vault-wide Search (Ctrl+Shift+F) ──
      registerCommandWithShortcut({
        name: 'vault:search',
        label: 'Search Vault',
        description: 'Open the vault-wide Search panel',
        binding: { key: 'f', ctrl: true, shift: true },
        // Fires from inside a TipTap editor so users editing a tile can hop
        // into Search without breaking focus. Mirrors editor:insert-link.
        allowInEditor: true,
        execute: () => {
          if (vaultStore.project === null) return;
          searchStore.openPanel('find');
        },
      }),

      // ── Phase 6.4 (IMPLEMENTATION_PLAN_2026-05-27) — Tab bar a11y ──
      //
      // Ctrl+W closes the active tab; Ctrl+Tab cycles forward, Ctrl+Shift+Tab
      // cycles backward. All three respect the standard hotkeys editor
      // guard (an editor with `allowInEditor: false` will skip these),
      // matching browser / VS Code semantics.
      registerCommandWithShortcut({
        name: 'tab:close',
        label: 'Close Tab',
        description: 'Close the active tab',
        binding: { key: 'w', ctrl: true },
        execute: () => {
          const activeId = tabStore.activeTabId;
          if (!activeId) return;
          tabStore.close(activeId);
        },
      }),
      registerCommandWithShortcut({
        name: 'tab:next',
        label: 'Next Tab',
        description: 'Cycle to the next open tab',
        binding: { key: 'Tab', ctrl: true },
        execute: () => {
          if (tabStore.count < 2) return;
          const ids = tabStore.tabs.map((t) => t.id);
          const cur = tabStore.activeTabId;
          if (!cur) return;
          const idx = ids.indexOf(cur);
          if (idx < 0) return;
          tabStore.setActive(ids[(idx + 1) % ids.length]);
        },
      }),
      registerCommandWithShortcut({
        name: 'tab:prev',
        label: 'Previous Tab',
        description: 'Cycle to the previous open tab',
        binding: { key: 'Tab', ctrl: true, shift: true },
        execute: () => {
          if (tabStore.count < 2) return;
          const ids = tabStore.tabs.map((t) => t.id);
          const cur = tabStore.activeTabId;
          if (!cur) return;
          const idx = ids.indexOf(cur);
          if (idx < 0) return;
          tabStore.setActive(ids[(idx - 1 + ids.length) % ids.length]);
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

  // Intercept clicks on filo:// internal links and http(s):// external links
  // (from Tiptap editor content via the Insert Link toolbar action).
  $effect(() => {
    function handleLinkClick(e: MouseEvent) {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (isFiloLink(href)) {
        e.preventDefault();
        e.stopPropagation();
        linksStore.handleLinkClick(href);
      } else if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
        // External URLs: hand off to the OS default browser / mail client
        // / dialler via the media:open-external IPC. Sprint A / A5 — the
        // previous regex only matched `http(s)://`, so a `mailto:` or
        // `tel:` link inside a TipTap editor either silently no-op'd or
        // tried to navigate the renderer (potentially nuking unsaved
        // state). Both schemes are already in the sanitizeHtml allowlist
        // and the main-side `ALLOWED_URL_PREFIXES`.
        // Phase 5 — `asSafeOpenExternal` is the renderer-side gate; the
        // main handler re-checks (defence-in-depth) but rejecting here
        // avoids an IPC roundtrip for obvious bad input.
        const safe = asSafeOpenExternal(href);
        if (!safe) return;
        e.preventDefault();
        e.stopPropagation();
        // allow-envelope-bare: fire-and-forget click handler; failure is
        // user-visible (browser doesn't open) and not worth a toast.
        void window.filo.invoke('media:open-external', safe);
      }
    }
    document.addEventListener('click', handleLinkClick, true);
    return () => document.removeEventListener('click', handleLinkClick, true);
  });

  // V7: Vaults are opened via folder picker from the HomeScreen.
  // No .filo file association handling needed.

  // Prevent native context menu on the app — except inside editable text,
  // where the browser's native menu provides spell-check suggestions.
  function handleContextMenu(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="app-shell" oncontextmenu={handleContextMenu}>
  <a class="skip-link" href="#main-workspace">Skip to content</a>
  <GlobalToolbar onGoHome={goHome} />

  <div class="app-body">
    {#if vaultStore.project !== null && !shouldShowHome && !uiStore.sidebarFloating}
      <VaultSidebar open={uiStore.sidebarOpen} />
    {/if}

    <main id="main-workspace" class="workspace" aria-label="Board workspace">
      {#if shouldShowHome}
        <HomeScreen onReturnToProject={() => showHome = false} />
      {:else if tabStore.count > 0}
        <div class="board-viewport">
          {#if workspaceStore.paneTree}
            <SplitPaneContainer node={workspaceStore.paneTree} />
          {/if}
          <PaneDropOverlay />
        </div>
      {:else if vaultStore.project !== null}
        <div class="empty-workspace">
          <button class="empty-workspace-btn" onclick={() => uiStore.openModal('board-browser')} aria-label="Open Board Browser">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="12" y1="8" x2="12" y2="16"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
            <span>Open a Tab to get started</span>
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
    switches by virtue of being a sibling of the workspace.
  -->
  {#if vaultStore.project !== null && !shouldShowHome && uiStore.sidebarFloating}
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
    Phase 3 / 3.7 (A-4) — gate the keyboard-shortcuts modal mount on the
    open-modal id so its DOM and the lazy KeyboardShortcutsModal contents
    only exist while the panel is visible. Every other modal in this block
    already follows the same pattern; the unconditional mount here was an
    inconsistency, not a deliberate choice (the inner Modal component still
    gates `<dialog showModal()>` on its own, but pre-3.7 the wrapper paid
    the always-mounted cost).
  -->
  {#if uiStore.isModalOpen('keyboard-shortcuts')}
    <Modal id="keyboard-shortcuts" title="Help" width="520px">
      <KeyboardShortcutsModal />
    </Modal>
  {/if}

  <!--
    Board Browser: slide-up panel above TabBar.
    Polish phase 1.5 — transparent click-outside backdrop wraps the panel.
    Clicks outside the panel close the modal (matching `Modal.svelte`'s
    `e.target === dialogEl` pattern via a target-equality check on the
    backdrop). Clicks inside the panel bubble normally so buttons, the
    inline rename input, and BoardBrowser's own handlers keep working —
    the in-flight rename's onblur commit still fires when the panel
    unmounts, so a partial rename isn't lost.
  -->
  {#if uiStore.isModalOpen('board-browser')}
    <div
      class="board-browser-backdrop"
      onclick={(e) => { if (e.target === e.currentTarget) uiStore.closeModal(); }}
      onkeydown={(e) => { if (e.key === 'Escape') uiStore.closeModal(); }}
      role="presentation"
      aria-hidden="true"
    >
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
          <BoardBrowserModal />
        </div>
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
      title="Project Settings"
      width="680px"
      beforeClose={() => confirmDiscardSettings(pendingSettingsStore, uiStore)}
    >
      <ProjectSettingsModal />
    </Modal>
  {/if}

  {#if uiStore.isModalOpen('recovery-files')}
    <Modal id="recovery-files" title="Recovered from unflushed changes" width="520px">
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
   * Polish phase 1.5 — full-viewport invisible click-catcher that closes
   * the Board Browser on outside-click. No background colour so the rest
   * of the app stays visible (the existing "no backdrop overlay" intent
   * from the previous comment is preserved — only the *interaction*
   * changes, not the visual presentation).
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
    /* Audit 6.4 — paint one layer above the click-catcher backdrop
       (--z-modal-backdrop, 3000) rather than sharing it. Sharing was correct
       only by DOM order; --z-modal (3001) makes the stacking explicit. */
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
