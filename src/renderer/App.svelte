<script lang="ts">
  import { onDestroy } from 'svelte';
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
  import { settleBoardFailureToasts, trackBoardFailureToast } from './lib/boards/writeFailureToasts';
  import { retryAllFailedWrites } from './lib/boards/writeSchedulerFailures';
  import { retryAndReport } from './lib/boards/retryFeedback';
  import { hasOpenSettingsEdits, settleOpenSettings } from './lib/settings/settleOpenSettings';
  import { listenForSyncConflicts } from './lib/vault/syncConflictNotices';
  import { handleFlushAndQuit } from './lib/vault/handleFlushAndQuit';
  import { saveUntilSettled } from './stores/vaultLeaveGuard';
  import { holdCloseDrainUntilSwap } from './lib/editor/closeDrainGate.svelte';
  import { isUnsavedWorkEmpty, unsavedWork } from './lib/boards/writeStateTracking';
  import { describeUnsaved, keepRescueCopies, preservedTmpCount } from './stores/unsavedRescue';
  import { rollbackRawRescues } from './lib/notes/rawViews';
  import { flushDirtyFlagSentinel } from './lib/vault/dirtyFlagRecovery';
  import { historyStore } from './stores/history.svelte';
  import { themeVersion } from './stores/themeVersion.svelte';
  import { applyBarColours } from './lib/themes/chromeText';
  import { tabStore } from './stores/tabs.svelte';
  import { workspaceStore } from './stores/workspace.svelte';
  import { registerDriftPromptHandlers } from './stores/vaultExternalDriftPrompts';
  import { registerNewNotesInTree } from './stores/newNotesInTree';
  import { registerBoardNamesFollowFiles } from './stores/boardIdentity';
  import { pushSaveState } from './stores/saveStateFeed';
  import { heldDecisionPaths, heldDecisions, setHeldDecisionsListener } from './stores/heldDecisions';
  import { handleSessionEnding } from './lib/vault/handleSessionEnding';
  import { startUnsavedStateReport } from './lib/vault/unsavedStateReport';

  // The markdown and board writers ask before overwriting a file another
  // program changed; without this they keep the local version silently.
  registerDriftPromptHandlers();
  // The watcher never reports our own creates, so a new note re-reads the tree.
  registerNewNotesInTree();
  // A `.board.json` renamed in the sidebar or by another program renames its board.
  registerBoardNamesFollowFiles();

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
  // markdown/frontmatter writers (TextTile, DocumentEditor, TaskListBoard);
  // 'board' covers .board.json; 'config' covers .filo/
  // config files.
  //
  // Route through a DEDICATED coalescing aggregator (keyed by write kind) so a
  // multi-target failure (e.g. many dirty .board.json on a full disk)
  // collapses into one count-badged toast per kind. Separate from the errorBus
  // aggregator below so the two coalescing namespaces can't cross-talk.
  //
  // When the atomic write preserved its tmp on ENOSPC/EIO/EACCES,
  // `buildWriteErrorToast` names that location so the user can recover the
  // bytes.
  const writeErrorAggregator = createErrorToastAggregator(
    {
      pushToast: (opts) => uiStore.pushToast(opts),
      updateToastText: (id, text) => uiStore.updateToastText(id, text),
      updateToastActions: (id, actions) => uiStore.updateToastActions(id, actions),
    },
    { details: () => saveStateStore.requestDetails() },
  );
  setBoardWriteErrorListener((info) => {
    const { context, message, coalesceKey, retryable } = buildWriteErrorToast(info);
    // Thread the per-preserved-path coalesceKey so two same-kind failures
    // with DIFFERENT preserved-tmp locations each keep their own toast (the
    // display prefix stays `context`). Retry re-fires every retained failed
    // write (all five schedulers).
    const actions = retryable
      ? [{ label: 'Retry', handler: () => retryAndReport() }]
      : undefined;
    // Retry re-fires every failed write, so it fits a toast that names several files.
    const toastId = writeErrorAggregator({ context, error: info.error, message, coalesceKey, path: info.path, sharedActions: actions });
    // Closed once the board is saved, or nothing is owed for it any more.
    if (info.kind === 'board' && info.path) trackBoardFailureToast(toastId, info.path);
  });

  // On every write-state change, feed the save-state store the same answer
  // close and quit use (`unsavedWork()`), so the toolbar indicator reads
  // yellow while anything at all is unsaved, including a note body held in
  // memory with no write armed, not only while a write is in flight.
  //
  // Also forward the concrete failed paths so the
  // toolbar popover can list them and offer a Retry button. setStatus
  // clears the path list on a clean drain (inflight=0, failed=0).
  //
  // The ledger notifies from inside a write, and the note store clears a
  // saved body's flag in the code after that write's `await`, so the last
  // notification of a save still sees the body as unsaved. One more read on
  // the next task, once those continuations have run, settles it.
  // A prompt held or answered changes what the indicator shows, with or
  // without a write.
  // Main is kept told whether leaving now could lose work, so it can answer
  // Windows at once when the session ends (see handleSessionEnding).
  const unsavedStateSources = {
    nothingUnsaved: () => isUnsavedWorkEmpty(unsavedWork()),
    heldDecisionCount: () => heldDecisions().length,
    openSettingsEdits: () => hasOpenSettingsEdits(),
  };
  const unsavedStateReport = startUnsavedStateReport(unsavedStateSources, (flag) => window.filo.send('app:unsaved-state', flag));
  onDestroy(() => unsavedStateReport.stop());
  setHeldDecisionsListener(() => {
    pushSaveState();
    unsavedStateReport.nudge();
  });
  let saveStateRecheck: ReturnType<typeof setTimeout> | null = null;
  setBoardWriteStateListener(() => {
    unsavedStateReport.nudge();
    pushSaveState();
    settleBoardFailureToasts((id) => uiStore.dismissToast(id, { silent: true }));
    saveStateRecheck ??= setTimeout(() => {
      saveStateRecheck = null;
      pushSaveState();
    }, 0);
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
  // Readable: a context is an id, so the toast shows the message (or a label),
  // and a report about another file opens its own toast.
  onError(
    createErrorToastAggregator(
      {
        pushToast: (opts) => uiStore.pushToast(opts),
        updateToastText: (id, text) => uiStore.updateToastText(id, text),
      },
      { readable: true },
    ),
  );

  // Drain pending writes when the main process is about to quit.
  // Main blocks shutdown until we send `app:ready-to-quit` (or its 5s
  // timeout fires), so a graceful quit always gets a flush attempt.
  // On a save failure, the handler surfaces a Confirm dialog
  // ("Retry now" / "Quit anyway" / "Stay open"). "Stay open" sends
  // `app:cancel-quit` so main rewinds `isFlushingForQuit`.
  window.filo.on('app:flush-and-quit', () => {
    void handleFlushAndQuit({
      saveStateState: () => saveStateStore.state,
      // The same save, freeze and check as closing the vault: a field that
      // saves on blur hands its text over, and whatever a view or a queued
      // reconcile hands over meanwhile gets a second save.
      save: () => saveUntilSettled(() => vaultStore.save()),
      freeze: () => holdCloseDrainUntilSwap(),
      nothingUnsaved: () => isUnsavedWorkEmpty(unsavedWork()),
      send: (channel) => window.filo.send(channel),
      reportError,
      // Drain the dirty-flag sentinel mutex so the markClean queued by save()
      // lands before main destroys the renderer (else a clean quit leaves
      // `.filo/.dirty` → phantom recovery next launch).
      flushSentinel: () => flushDirtyFlagSentinel(),
      // "Retry now" re-fires every retained failed write.
      retryFailed: () => retryAllFailedWrites(),
      describeUnsaved: () => describeUnsaved(),
      preservedTmpCount: () => preservedTmpCount(),
      keepRescueCopies: () => keepRescueCopies(),
      rollbackRescue: () => rollbackRawRescues(),
      // A theme being edited or a Settings tab's unapplied fields: Apply /
      // Discard / Cancel before the save, which can't see them.
      openSettingsEdits: () => hasOpenSettingsEdits(),
      settleOpenSettings: () => settleOpenSettings('quit'),
      // When only decisions are left, the dialog offers to show them.
      heldDecisionPaths: () => heldDecisionPaths(),
      showDecisions: () => saveStateStore.requestDetails(),
    });
  });

  // Windows is ending the session and main is holding it back: save, keep
  // rescue copies of what is left (unapplied Settings too), no dialog.
  window.filo.on('app:session-ending', () => {
    void handleSessionEnding({
      save: () => saveUntilSettled(() => vaultStore.save()),
      freeze: () => holdCloseDrainUntilSwap(),
      ...unsavedStateSources,
      keepRescueCopies: (opts) => keepRescueCopies(unsavedWork(), opts),
      flushSentinel: () => flushDirtyFlagSentinel(),
      send: (channel) => window.filo.send(channel),
      reportError,
    });
  });

  // Let the history store auto-switch to a command's originating
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

  // The external-change renderer bridge (watcher events → reconcilers) is
  // app-lifetime, keyed only on "a vault is open". Data plumbing must not ride
  // on UI layout state: e.g. hosting it in the sidebar would drop watcher
  // events (worst case a `vault:file-renamed`, skipping the rename cascade)
  // whenever the sidebar toggles between docked and floating.
  $effect(() => {
    if (vaultStore.isOpen) {
      return vaultStore.listenForChanges();
    }
  });
  // Live sync-conflict notices (a board fork / a
  // refused conflict-copy rename). Same app-lifetime ownership as above.
  $effect(() => {
    if (vaultStore.isOpen) {
      return listenForSyncConflicts(() => vaultStore.path ?? '');
    }
  });

  // Write project font-size settings onto `:root` as CSS variables.
  // NOTE: only `--font-size-base` (system chrome) cascades globally. The
  // Default Board Font Size values are the bottom layer of each element's
  // style cascade (`effectiveStyle.ts`), read there, not CSS variables.
  //
  // Runs again after every theme paint (`themeVersion`): a paint clears the
  // inline variables the previous theme set, and the toolbar and tab bar
  // colour settings sit over the new theme's.
  $effect(() => {
    const general = vaultStore.project?.settings?.general;
    if (!general) return;
    void themeVersion.value;
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
    // The toolbar / tab bar colour settings sit over the theme's; blank leaves
    // the bar to the theme (a custom theme may colour it).
    applyBarColours(root, general.toolbarColor ?? '', general.tabBarColor ?? '');
    if (typeof general.historyLimit === 'number') {
      historyStore.setMaxHistory(general.historyLimit);
    }
  });
</script>

<AppShell />
