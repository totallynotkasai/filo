<script lang="ts">
  import AppShell from './components/layout/AppShell.svelte';
  import { themeStore } from './stores/theme.svelte';
  import { vaultStore } from './stores/vault.svelte';
  import { uiStore } from './stores/ui.svelte';
  import { saveStateStore } from './stores/saveState.svelte';
  import {
    setWriteErrorListener as setBoardWriteErrorListener,
    setWriteStateListener as setBoardWriteStateListener,
  } from './lib/boards/boardSaver';
  import { onError, reportError } from './lib/utils/errorBus';
  import { createErrorToastAggregator } from './lib/utils/errorToastAggregator';
  import { buildWriteErrorToast } from './lib/boards/writeErrorToast';
  import { retryAllFailedWrites } from './lib/boards/writeSchedulerFailures';
  import { listenForSyncConflicts } from './lib/vault/syncConflictNotices';
  import { handleFlushAndQuit } from './lib/vault/handleFlushAndQuit';
  import { flushDirtyFlagSentinel } from './lib/vault/dirtyFlagRecovery';
  import { historyStore } from './stores/history.svelte';
  import { tabStore } from './stores/tabs.svelte';
  import { workspaceStore } from './stores/workspace.svelte';

  // Apply the default theme to the DOM on startup. Routing through
  // themeStore.setBuiltin keeps every theme switch on a single code path.
  themeStore.setBuiltin(themeStore.active);

  // Load the per-machine sidebar state (width + floating mode + bounds).
  // Fire-and-forget; the sidebar component reads `uiStore.sidebarWidth`
  // reactively, and the floating panel reads `uiStore.floatingBounds`.
  void uiStore.hydrateSidebarState();

  // Surface any failed debounced write to the user. The lib layer cannot
  // import the toast store directly (architecture layering), so it emits
  // through a listener wired here. 'component' covers per-component
  // markdown/frontmatter writers (TextTile, DocumentEditor, PropertiesPopup,
  // TaskListBoard); 'board' covers .board.json; 'config' covers .filo/
  // config files.
  //
  // Audit-7 L2 — route through a DEDICATED coalescing aggregator (keyed by
  // write kind via `buildWriteErrorToast`'s context) so a multi-target failure
  // (e.g. many dirty .board.json on a full disk) collapses into one
  // count-badged toast per kind instead of one persistent toast per file.
  // Separate instance from the errorBus aggregator below so the two coalescing
  // namespaces can't cross-talk.
  //
  // Audit-7 M5 — when the atomic write preserved its tmp on ENOSPC/EIO/EACCES,
  // `buildWriteErrorToast` names that location so the user can recover the
  // bytes (the old hardcoded "not on disk yet" copy was wrong — they ARE on
  // disk at the preserved tmp path).
  const writeErrorAggregator = createErrorToastAggregator({
    pushToast: (opts) => uiStore.pushToast(opts),
    updateToastText: (id, text) => uiStore.updateToastText(id, text),
  });
  setBoardWriteErrorListener((info) => {
    const { context, message, coalesceKey, retryable } = buildWriteErrorToast(info);
    // A9-L10 — thread the per-preserved-path coalesceKey so two same-kind
    // failures with DIFFERENT preserved-tmp locations each keep their own
    // toast (the display prefix stays `context`). Audit-19 EXT-5 — Retry
    // re-fires every retained failed write (all five schedulers).
    const actions = retryable
      ? [{ label: 'Retry', handler: async () => {
          const { failed } = await retryAllFailedWrites();
          if (failed.length > 0) uiStore.toast('Save still failing. Filo will try again on the next save and at quit.', 'error', 6000);
        } }]
      : undefined;
    writeErrorAggregator({ context, error: info.error, message, coalesceKey, actions });
  });

  // Feed boardSaver's begin/end counts into the save-state store so the
  // global toolbar can render an idle / saving / saved / error indicator.
  //
  // Phase C / C.10 — also forward the concrete failed paths so the
  // toolbar popover can list them and offer a Retry button. setStatus
  // clears the path list on a clean drain (inflight=0, failed=0).
  setBoardWriteStateListener(({ inflight, failed, pending, failedPaths }) => {
    saveStateStore.setStatus(inflight, failed, pending);
    for (const path of failedPaths) saveStateStore.noteFailedPath(path);
  });

  // Generic error bus subscription. Surfaces failures from non-write
  // call sites (vault open/create/refresh, flush-and-quit) that don't go
  // through `setBoardWriteErrorListener`. Persistent toast so the user
  // can read it after the operation completes.
  //
  // Rapid-fire errors from the same `context` (e.g. a tag-rename sweep
  // that fails 30 .md writes) are coalesced by the aggregator into a
  // single toast with a count badge so bulk failures don't spam the
  // stack. See `createErrorToastAggregator` for the policy.
  onError(
    createErrorToastAggregator({
      pushToast: (opts) => uiStore.pushToast(opts),
      updateToastText: (id, text) => uiStore.updateToastText(id, text),
    }),
  );

  // Drain pending writes when the main process is about to quit.
  // Main blocks shutdown until we send `app:ready-to-quit` (or its 5s
  // timeout fires), so a graceful quit always gets a flush attempt.
  // 6.2.H4 — on a save failure, the handler surfaces a Confirm dialog
  // ("Retry now" / "Quit anyway" / "Stay open") instead of sleeping 200 ms
  // and unconditionally exiting. "Stay open" sends the new
  // `app:cancel-quit` signal so main rewinds `isFlushingForQuit`.
  window.filo.on('app:flush-and-quit', () => {
    void handleFlushAndQuit({
      saveStateState: () => saveStateStore.state,
      save: () => vaultStore.save(),
      send: (channel) => window.filo.send(channel),
      reportError,
      // Audit-6 M5 — drain the dirty-flag sentinel mutex so the markClean
      // queued by save() lands before main destroys the renderer (else a
      // clean quit leaves `.filo/.dirty` → phantom recovery next launch).
      flushSentinel: () => flushDirtyFlagSentinel(),
      // Audit-19 EXT-5 — "Retry now" re-fires every retained failed write.
      retryFailed: () => retryAllFailedWrites(),
    });
  });

  // Audit 5.3 — let the history store auto-switch to a command's originating
  // board on undo/redo. Registered here (not inside history.svelte) because
  // tabs.svelte.ts imports historyStore, so history can't import the tab /
  // workspace stores back without a cycle. Returns true when the board is open
  // and was brought into focus; false when it isn't open anywhere (history
  // then keeps its switch-back toast and leaves the command on the stack).
  historyStore.setBoardActivator((boardId) => {
    const tab = tabStore.tabs.find((t) => t.boardId === boardId);
    if (!tab) return false;
    const leaf = workspaceStore.findLeafByTab(tab.id);
    if (leaf) {
      // Already shown in a (non-active) pane — focus that pane.
      workspaceStore.setActivePane(leaf.id);
    } else {
      // Open as a tab but not shown in any pane — retarget the active pane.
      const activeLeaf = workspaceStore.activeLeaf;
      if (activeLeaf) workspaceStore.setLeafTab(activeLeaf.id, tab.id);
    }
    tabStore.setActive(tab.id);
    return true;
  });

  // Audit-16 3.7 — the external-change renderer bridge (watcher events →
  // reconcilers) is app-lifetime, keyed only on "a vault is open". It used
  // to live in VaultSidebar's mount lifecycle, but the docked and floating
  // sidebars are mutually exclusive `{#if}` branches in AppShell — toggling
  // float/dock destroyed one instance (unsubscribing every watcher listener
  // and discarding a mid-debounce tree reconcile) before mounting the
  // other, and any watcher event delivered in that gap was dropped. A
  // dropped `vault:file-renamed` is the worst case: the rename cascade
  // never runs, and the later reconcile sees delete+create and can evict
  // the board as missing. Data plumbing must not ride on UI layout state.
  $effect(() => {
    if (vaultStore.isOpen) {
      return vaultStore.listenForChanges();
    }
  });
  // Audit-19 ERR-3 / EXT-2 — live sync-conflict notices (a board fork / a
  // refused conflict-copy rename). Same app-lifetime ownership as above.
  $effect(() => {
    if (vaultStore.isOpen) {
      return listenForSyncConflicts(() => vaultStore.path ?? '');
    }
  });

  // Write project font-size settings onto `:root` as CSS variables.
  // NOTE: only `--font-size-base` (system chrome) cascades globally.
  // The Default Board Font Size values (tileTitle, tileBody,
  // connectionLabel, frameTitle, kanbanColumnTitle, kanbanCardTitle,
  // kanbanCardBody, taskListTitle, taskItem) are creation-time seeds
  // — they're baked into per-element style overrides at creation by
  // the element factories and do NOT drive a global CSS variable.
  // Existing elements retain their per-element override (or fall
  // through to the CSS-declared fallback in `style.css`). Users can
  // retroactively apply current defaults via the
  // "Apply to all Existing Items" button in General Settings.
  $effect(() => {
    const general = vaultStore.project?.settings?.general;
    if (!general) return;
    const root = document.documentElement;
    if (typeof general.globalFontSize === 'number') {
      root.style.setProperty('--font-size-base', `${general.globalFontSize}px`);
    }
    // Per-surface UI scales. Each surface multiplies its base sizes by
    // its corresponding CSS variable (e.g. the Global Toolbar height is
    // `44 * var(--ui-toolbar-scale)`).
    if (typeof general.globalToolbarScale === 'number') {
      root.style.setProperty('--ui-toolbar-scale', `${general.globalToolbarScale}`);
    }
    if (typeof general.boardToolbarScale === 'number') {
      root.style.setProperty('--ui-board-toolbar-scale', `${general.boardToolbarScale}`);
    }
    if (typeof general.tabBarScale === 'number') {
      root.style.setProperty('--ui-tabbar-scale', `${general.tabBarScale}`);
    }
    if (typeof general.minimapScale === 'number') {
      root.style.setProperty('--ui-minimap-scale', `${general.minimapScale}`);
    }
    if (typeof general.waypointScale === 'number') {
      root.style.setProperty('--ui-waypoint-scale', `${general.waypointScale}`);
    }
    // Toolbar / tab-bar background colours flow through CSS variables so
    // themes (and the systemOnly switch) can override them at the :root
    // level. Empty string clears the variable so the CSS fallback wins.
    if (typeof general.toolbarColor === 'string') {
      if (general.toolbarColor) root.style.setProperty('--toolbar-bg', general.toolbarColor);
      else root.style.removeProperty('--toolbar-bg');
    }
    if (typeof general.tabBarColor === 'string') {
      if (general.tabBarColor) root.style.setProperty('--tabbar-bg', general.tabBarColor);
      else root.style.removeProperty('--tabbar-bg');
    }
    if (typeof general.historyLimit === 'number') {
      historyStore.setMaxHistory(general.historyLimit);
    }
  });
</script>

<AppShell />
