/**
 * UI store — manages sidebar toggle, modal states, context menu, toast queue.
 */
import { SvelteMap } from 'svelte/reactivity';
import { onVaultSwap } from '../core/vaultLifecycle';
import { reportError } from '../lib/utils/errorBus';
import type { RelinkTargets } from '../lib/vault/relinkTargets';

// ── Sidebar ──
let sidebarOpen = $state(true);
let sidebarWidth = $state(240);
// In-app floating mode: when true, AppShell renders the vault sidebar
// inside a draggable `FloatingVaultPanel` instead of the docked column.
let sidebarFloating = $state(false);
let floatingBounds = $state<{ x: number; y: number; width: number; height: number }>({
  x: 80,
  y: 80,
  width: 320,
  height: 560,
});

// Hydration tracks whether we've fetched the per-machine sidebar state
// from main so we don't echo bootstrap defaults back to disk.
let sidebarHydrated = false;
let sidebarWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let floatingBoundsSaveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Board Toolbar ──
let boardToolbarVisible = $state(true);

// ── Modals ──
let activeModal = $state<string | null>(null); // 'keyboard-shortcuts', 'board-browser', 'project-settings', etc.

// Side-channel context for the Re-link modal so the
// keyless `openModal('relink-tile')` API doesn't need to thread the tile
// id + compatible extension list through its argument shape.
interface RelinkContext { tileId: string; targets: RelinkTargets }
let relinkContext = $state<RelinkContext | null>(null);

// ── Confirm dialog ──
//
// A separate piece of state from `activeModal` so a confirm dialog can
// overlay another modal (e.g. the destructive "Apply to all Boards"
// buttons live inside the Project Settings modal and need the confirm
// to stack on top without dismissing the parent).
export interface ConfirmDialogConfig {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Optional inline checkbox rendered between body and the action buttons.
   * The current checked state is passed to `onConfirm(checked)`. Initial
   * value defaults to `false`. Cancel ignores the toggle. Used by the
   * tile-delete flow so the user can opt into deleting the backing vault
   * file in the same dialog without bumping out to a second prompt.
   */
  extraOption?: {
    label: string;
    hint?: string;
    initial?: boolean;
  };
  onConfirm: (extraOptionChecked: boolean) => void;
  onCancel?: () => void;
  /**
   * An optional third, non-destructive button rendered between
   * Cancel and Confirm (the quit dialog's "Retry now"). Clicking it closes the
   * dialog and calls `onClick` — neither onConfirm nor onCancel fires.
   */
  secondaryAction?: { label: string; onClick: () => void };
  /**
   * A notice, not a question: only the confirm button (its label, e.g. "OK")
   * is shown. Escape still closes it through `onCancel`.
   */
  notice?: boolean;
}

let confirmDialog = $state<ConfirmDialogConfig | null>(null);
/** Confirms asked for while another was showing; each shows once the one before is answered. */
let queuedConfirms: ConfirmDialogConfig[] = [];

/** Shows the next queued confirm, if any (the current one was answered). */
function showNextConfirm(): void {
  confirmDialog = queuedConfirms.shift() ?? null;
}

// ── Sidebar pending-rename signal ──
//
// When the user clicks "New Folder" in the sidebar
// toolbar, the new node should mount already in rename mode with its
// name selected so the user can type the real name without an extra
// click. The toolbar sets this to the new folder's absolute path; the
// matching `VaultFileItem` reads it on mount, fires `startRename()`,
// and clears the flag.
let pendingSidebarRenameId = $state<string | null>(null);

// ── Context Menu ──
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  context?: unknown; // context data (tile id, board id, etc.)
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean; // if true, renders as separator
  /** A non-interactive label over the items that follow it; skipped by keyboard navigation. */
  heading?: boolean;
  /** When boolean, renders the item as role="menuitemcheckbox" with aria-checked; reserves a leading checkmark slot in the menu so all rows align. */
  checked?: boolean;
  action?: () => void;
}

let contextMenu = $state<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  items: [],
});

// ── Toast ──
export interface ToastAction {
  label: string;
  /**
   * Invoked when the action button is clicked. The toast is auto-dismissed.
   * Async handlers (`Promise<void>` return) are accepted so the action can
   * `await` IPC work without losing the rejection if it throws — the
   * dispatcher (`invokeToastAction`) wraps the call in try/catch.
   */
  handler: () => void | Promise<void>;
}

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  actions?: ToastAction[];
  /** Fires when the toast dismisses without any action being invoked. */
  onDismiss?: () => void;
  /**
   * The toast's `onDismiss` means "the user acknowledged this → destroy the
   * underlying recovery breadcrumb" (e.g. `clearQuitFailureBreadcrumb`,
   * `markClean`). The automatic dismissal paths (vault-swap teardown,
   * TOAST_CAP eviction) skip its `onDismiss`, so only a genuine user action
   * consumes the breadcrumb — otherwise it re-surfaces next launch.
   */
  acknowledgeOnly?: boolean;
  /**
   * A decision toast that stays until the user acts on it (no lifetime
   * timer). Refused when `onDismiss` is set: a promise-backed toast keeps the
   * 15s cap so it can never strand its write.
   */
  sticky?: boolean;
  /** A newer toast with the same key silently replaces this one. */
  dedupeKey?: string;
  /**
   * Kept when the vault closes or another opens: a notice about the vault
   * just left (where its rescue copies went) that the user must still see.
   * Only for a sticky toast whose actions don't touch vault state.
   */
  survivesSwap?: boolean;
}

let toasts = $state<ToastMessage[]>([]);
let toastCounter = 0;
const toastTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

/**
 * Every toast auto-dismisses after at most this long, including external-edit
 * decision toasts that pass `duration: 0`. Auto-dismiss is the non-destructive
 * default: the lossy "Reload / discard" choice always requires an explicit
 * click, so a timeout only keeps the user's in-memory state (the write-blocking
 * promise toasts resolve to 'defer' on dismiss — see
 * vaultExternalDriftPrompts.ts). The cap stops a re-firing conflict prompt from
 * blanketing the screen. A NON-promise decision toast may opt into `sticky`
 * (no timer) with a `dedupeKey`, which replaces any older toast for the same
 * file so it still can't stack.
 */
const TOAST_MAX_LIFETIME_MS = 15000;

export const uiStore = {
  // Sidebar
  get sidebarOpen() { return sidebarOpen; },
  toggleSidebar() { uiStore.setSidebarOpen(!sidebarOpen); },
  // Hide Vault and the toolbar toggle. Per machine (`sidebar-state.json`),
  // so a hidden sidebar stays hidden after a restart.
  setSidebarOpen(open: boolean) {
    if (sidebarOpen === open) return;
    sidebarOpen = open;
    if (!sidebarHydrated) return;
    void window.filo.invoke('sidebar:set-state', { open });
  },

  // Sidebar width (per-machine, persisted via `sidebar:set-state` IPC).
  get sidebarWidth() { return sidebarWidth; },
  setSidebarWidth(width: number, options: { persist?: boolean } = {}) {
    const clamped = Math.max(240, Math.min(600, Math.round(width)));
    if (sidebarWidth !== clamped) sidebarWidth = clamped;
    if (options.persist === false || !sidebarHydrated) return;
    if (sidebarWidthSaveTimer) clearTimeout(sidebarWidthSaveTimer);
    sidebarWidthSaveTimer = setTimeout(() => {
      sidebarWidthSaveTimer = null;
      void window.filo.invoke('sidebar:set-state', { width: clamped });
    }, 300);
  },

  // In-app floating mode. When true the docked sidebar slot is hidden
  // and `FloatingVaultPanel` renders the sidebar inside a draggable
  // panel that persists across tab/board switches.
  get sidebarFloating() { return sidebarFloating; },
  setSidebarFloating(floating: boolean) {
    sidebarFloating = floating;
    if (!sidebarHydrated) return;
    void window.filo.invoke('sidebar:set-state', { floating });
  },

  get floatingBounds() { return floatingBounds; },
  setFloatingBounds(next: { x: number; y: number; width: number; height: number }, options: { persist?: boolean } = {}) {
    // Capture primitives BEFORE writing to `$state` — Svelte 5 wraps the
    // assigned object in a reactive Proxy that Electron's structured-clone
    // IPC can't serialize. The IPC payload below uses these locals so the
    // sent object is a plain `{ x, y, width, height }`.
    const x = Math.round(next.x);
    const y = Math.round(next.y);
    const width = Math.max(220, Math.round(next.width));
    const height = Math.max(240, Math.round(next.height));
    floatingBounds = { x, y, width, height };
    if (options.persist === false || !sidebarHydrated) return;
    if (floatingBoundsSaveTimer) clearTimeout(floatingBoundsSaveTimer);
    floatingBoundsSaveTimer = setTimeout(() => {
      floatingBoundsSaveTimer = null;
      void window.filo.invoke('sidebar:set-state', {
        floatingBounds: { x, y, width, height },
      });
    }, 300);
  },

  /**
   * Loads the per-machine sidebar state from main on startup. Idempotent.
   */
  async hydrateSidebarState() {
    if (sidebarHydrated) return;
    try {
      const state = await window.filo.invoke('sidebar:get-state');
      if (typeof state.open === 'boolean') {
        sidebarOpen = state.open;
      }
      if (typeof state.width === 'number') {
        sidebarWidth = Math.max(240, Math.min(600, Math.round(state.width)));
      }
      if (typeof state.floating === 'boolean') {
        sidebarFloating = state.floating;
      }
      if (state.floatingBounds) {
        const b = state.floatingBounds;
        floatingBounds = {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.max(220, Math.round(b.width)),
          height: Math.max(240, Math.round(b.height)),
        };
      }
    } catch (err) {
      console.warn('[uiStore] failed to load sidebar state:', err);
    }
    sidebarHydrated = true;
  },

  // Board Toolbar
  get boardToolbarVisible() { return boardToolbarVisible; },
  toggleBoardToolbar() { boardToolbarVisible = !boardToolbarVisible; },

  // Modals
  get activeModal() { return activeModal; },
  openModal(id: string) { activeModal = id; },
  closeModal() {
    activeModal = null;
    // Drop the per-modal side-channel state on close so a subsequent open of
    // the relink modal doesn't inherit the prior tile's context.
    relinkContext = null;
  },
  isModalOpen(id: string) { return activeModal === id; },

  // Relink modal context.
  get relinkContext() { return relinkContext; },
  openRelinkModal(tileId: string, targets: RelinkTargets) {
    relinkContext = { tileId, targets };
    activeModal = 'relink-tile';
  },

  // Confirm dialog
  get confirmDialog() { return confirmDialog; },
  openConfirm(config: ConfirmDialogConfig) {
    // A second confirm waits for the first to be answered. Neither may be
    // answered for the user: each dialog's onConfirm/onCancel is the only way
    // its awaiter resolves, and a Cancel is not always the harmless answer
    // (the open-time "Incomplete rename" prompt's Cancel is Discard).
    if (confirmDialog) {
      queuedConfirms.push(config);
      return;
    }
    confirmDialog = config;
  },
  /**
   * `openConfirm` as a promise: resolves `true` on Confirm, `false` on Cancel
   * (including Esc). The in-app replacement for the native `confirm()`, which
   * blocks the renderer event loop — and every debounced write timer with it.
   */
  confirmAsync(config: Omit<ConfirmDialogConfig, 'onConfirm' | 'onCancel' | 'extraOption' | 'secondaryAction'>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.openConfirm({ ...config, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
  },
  /** Closes the confirm on screen (its answer was taken); the next queued one shows. */
  closeConfirm() { showNextConfirm(); },

  // Sidebar pending-rename signal.
  get pendingSidebarRenameId() { return pendingSidebarRenameId; },
  setPendingSidebarRenameId(id: string | null) { pendingSidebarRenameId = id; },

  // Context Menu
  get contextMenu() { return contextMenu; },
  showContextMenu(x: number, y: number, items: ContextMenuItem[], context?: unknown) {
    // Pre-paint estimate only — a store can't measure the unmounted menu, so
    // this rough clamp (assumed 200px wide, ~32px/row) keeps the first frame
    // from rendering wildly off-screen. ContextMenu.svelte re-clamps against
    // the menu's *measured* size on mount, which is authoritative.
    const menuWidth = 200;
    const menuHeight = items.length * 32;
    const clampedX = Math.min(x, window.innerWidth - menuWidth);
    const clampedY = Math.min(y, window.innerHeight - menuHeight);

    contextMenu = {
      visible: true,
      x: Math.max(0, clampedX),
      y: Math.max(0, clampedY),
      items,
      context,
    };
  },
  hideContextMenu() {
    contextMenu = { visible: false, x: 0, y: 0, items: [] };
  },

  /**
   * Closes the single topmost dismissable layer, in priority order:
   * confirm dialog → modal → context menu. The global Escape handler
   * (`app:cancel`) routes through here so a confirm dialog stacked over a
   * modal dismisses on its own without also closing the modal beneath it.
   * Mirrors ConfirmDialog's own cancel by firing the confirm's
   * `onCancel`. Returns which layer closed, or null when nothing was open.
   */
  cancelTopLayer(): 'confirm' | 'modal' | 'context-menu' | null {
    if (confirmDialog) {
      const cfg = confirmDialog;
      showNextConfirm();
      cfg.onCancel?.();
      return 'confirm';
    }
    if (activeModal) {
      this.closeModal();
      return 'modal';
    }
    if (contextMenu.visible) {
      this.hideContextMenu();
      return 'context-menu';
    }
    return null;
  },

  // Toasts
  get toasts() { return toasts; },
  toast(text: string, type: ToastMessage['type'] = 'info', duration = TOAST_MAX_LIFETIME_MS) {
    return this.pushToast({ text, type, duration });
  },
  /**
   * Lower-level toast constructor that supports action buttons and a
   * dismissal callback. Returns the generated toast id.
   */
  pushToast(opts: {
    text: string;
    type?: ToastMessage['type'];
    duration?: number;
    actions?: ToastAction[];
    onDismiss?: () => void;
    acknowledgeOnly?: boolean;
    sticky?: boolean;
    dedupeKey?: string;
    survivesSwap?: boolean;
  }): string {
    // A dedupeKey replaces the older toast for the same subject. Silent unless the old one is promise-backed (its onDismiss
    // must still resolve → 'defer', never strand).
    if (opts.dedupeKey) {
      for (const t of toasts.filter((x) => x.dedupeKey === opts.dedupeKey)) {
        this.dismissToast(t.id, { silent: !t.onDismiss || t.acknowledgeOnly === true });
      }
    }
    let sticky = opts.sticky === true;
    if (sticky && opts.onDismiss) {
      if (import.meta.env.DEV) {
        console.warn('[Toast] sticky ignored on a promise-backed toast (onDismiss set); the lifetime cap applies.');
      }
      sticky = false;
    }
    // Cap the visible queue at 8 so an error storm (e.g. a tag-rename sweep
    // hitting an EPERM directory) can't paint the entire viewport.
    //
    // NEVER silently evict a promise-backed toast (one with `onDismiss` or
    // action buttons): the external-edit drift prompt resolves its awaiting
    // write ONLY through onDismiss/action, so a silent eviction would hang the
    // flush chain (and any Ctrl+S / quit drain). Prefer evicting a disposable
    // toast, oldest non-error first. Only if EVERY queued toast is
    // promise-backed, evict the oldest but fire its onDismiss (drift →
    // 'defer': keep dirty, re-prompt on the next write).
    const TOAST_CAP = 8;
    const isDisposable = (t: ToastMessage): boolean =>
      !t.sticky && !t.onDismiss && (!t.actions || t.actions.length === 0);
    while (toasts.length >= TOAST_CAP) {
      const disposable = toasts.filter(isDisposable);
      const victim =
        disposable.find((t) => t.type !== 'error') ??
        disposable[0] ??
        toasts.find((t) => t.type !== 'error') ??
        toasts[0];
      if (!victim) break; // loop guard (length >= TOAST_CAP) ensures toasts[0] exists
      // Fire onDismiss only when the victim is promise-backed. NEVER for an
      // `acknowledgeOnly` toast (a recovery breadcrumb): evicting it from the
      // screen must not also destroy the on-disk breadcrumb.
      this.dismissToast(victim.id, { silent: isDisposable(victim) || victim.acknowledgeOnly === true });
    }

    const id = `toast-${++toastCounter}`;
    const toast: ToastMessage = {
      id,
      text: opts.text,
      type: opts.type ?? 'info',
      duration: opts.duration ?? TOAST_MAX_LIFETIME_MS,
      actions: opts.actions,
      onDismiss: opts.onDismiss,
      acknowledgeOnly: opts.acknowledgeOnly,
      sticky,
      dedupeKey: opts.dedupeKey,
      survivesSwap: opts.survivesSwap === true && sticky,
    };
    toasts = [...toasts, toast];

    // An error toast with no explicit positive duration (save failed,
    // recovery-location hint) gets NO auto-dismiss timer: the failure outlives
    // the 15s window and the hint may be the only place the user learns WHERE
    // their bytes are. NON-error toasts — including promise-backed decision
    // warnings passing `duration: 0` — always auto-dismiss within the cap.
    const isStickyError = toast.type === 'error' && !(toast.duration && toast.duration > 0);
    if (!isStickyError && !sticky) {
      // A positive duration is honoured (capped at the max lifetime); `0`/unset
      // maps to the 15s cap.
      const lifetime =
        toast.duration && toast.duration > 0
          ? Math.min(toast.duration, TOAST_MAX_LIFETIME_MS)
          : TOAST_MAX_LIFETIME_MS;
      const timer = setTimeout(() => {
        toastTimers.delete(id);
        this.dismissToast(id);
      }, lifetime);
      toastTimers.set(id, timer);
    }

    return id;
  },
  /**
   * Runs a toast action by id, then dismisses the toast without firing
   * its `onDismiss` callback. If the action is missing, the toast is
   * dismissed normally.
   */
  invokeToastAction(id: string, actionIndex: number) {
    const toast = toasts.find((t) => t.id === id);
    if (!toast) return;
    const action = toast.actions?.[actionIndex];
    if (action) {
      // Route failures through the errorBus, not the console: toast actions
      // are destructive user decisions (Reload, Apply anyway, Keep local),
      // and with the toast already dismissed this is the only signal that
      // the action didn't take effect.
      const surface = (err: unknown): void =>
        reportError('toast.action', err, `Toast action "${action.label}" failed.`);
      try {
        const result = action.handler();
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(surface);
        }
      } catch (err) {
        surface(err);
      }
    }
    this.dismissToast(id, { silent: true });
  },
  dismissToast(id: string, options: { silent?: boolean } = {}) {
    const timer = toastTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    const toast = toasts.find((t) => t.id === id);
    toasts = toasts.filter((t) => t.id !== id);
    if (!options.silent && toast?.onDismiss) {
      try { toast.onDismiss(); } catch (err) { console.error('[Toast] onDismiss failed:', err); }
    }
  },
  /** Dismisses every toast registered under `dedupeKey`. */
  dismissToastsByKey(dedupeKey: string, options: { silent?: boolean } = {}) {
    for (const t of toasts.filter((x) => x.dedupeKey === dedupeKey)) {
      this.dismissToast(t.id, options);
    }
  },
  /**
   * Replaces the text of an existing toast in place. Returns true if the
   * toast was found and updated, false otherwise. Used by the errorBus
   * aggregator in App.svelte to coalesce rapid-fire errors from the same
   * subsystem into a single toast with an updated count badge instead of
   * pushing N separate toasts during a tag-rename sweep.
   */
  updateToastText(id: string, text: string): boolean {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    toasts = toasts.map((t, i) => (i === idx ? { ...t, text } : t));
    return true;
  },
  /** Replaces an existing toast's buttons. False when the toast is gone. */
  updateToastActions(id: string, actions: ToastAction[]): boolean {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    toasts = toasts.map((t, i) => (i === idx ? { ...t, actions } : t));
    return true;
  },
};

// Drop transient UI state when the vault swaps so a toast,
// open modal, context menu, or confirm dialog from the prior vault can't
// stay visible (or fire its callback against a now-unmounted backing
// store) after the new vault opens. Sidebar geometry stays — it's per
// machine, not per vault.
onVaultSwap('pre-swap', 'ui', () => {
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
  // Fire each toast's `onDismiss` before nulling the array: a Reload /
  // Keep-local toast is awaited via a Promise that resolves only through an
  // action or onDismiss, so nulling directly would strand
  // `inFlightDriftPrompts[path]` (and its awaiters). Best-effort — a thrown
  // onDismiss must not block the rest of the swap.
  for (const toast of toasts) {
    if (toast.survivesSwap) continue;
    // Skip `acknowledgeOnly` toasts (recovery breadcrumbs): dismissing one
    // runs the destructive `clearQuitFailureBreadcrumb` / `markClean`, which
    // would delete the outgoing vault's pointer to preserved unsaved bytes.
    // (Their `isStillSameVault` guard also fails by now, since the outgoing
    // generation is retired before pre-swap; this doesn't rely on it.)
    if (toast.onDismiss && !toast.acknowledgeOnly) {
      try { toast.onDismiss(); } catch (err) {
        console.error('[Toast] onDismiss failed during vault swap:', err);
      }
    }
  }
  toasts = toasts.filter((t) => t.survivesSwap);
  contextMenu = { visible: false, x: 0, y: 0, items: [] };
  activeModal = null;
  relinkContext = null;
  // Fire each confirm's onCancel (the one showing and every queued one) before
  // clearing them: a pending `confirmCloseAnyway` (tabStore.close /
  // closeOthers) resolves ONLY via onConfirm/onCancel, so nulling it directly
  // would suspend the close forever and strand a phantom tab. The outgoing
  // vault's generation is already retired, so a vault-guarded Cancel (the
  // open-time recovery prompts) does nothing to either vault.
  const confirms = [...(confirmDialog ? [confirmDialog] : []), ...queuedConfirms];
  confirmDialog = null;
  queuedConfirms = [];
  for (const cfg of confirms) {
    try { cfg.onCancel?.(); } catch (err) {
      console.error('[uiStore] confirm onCancel failed during vault swap:', err);
    }
  }
  pendingSidebarRenameId = null;
});
