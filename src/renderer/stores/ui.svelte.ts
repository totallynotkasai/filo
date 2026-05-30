/**
 * UI store — manages sidebar toggle, modal states, context menu, toast queue.
 */
import { SvelteMap } from 'svelte/reactivity';
import { onVaultSwap } from '../core/vaultLifecycle';

// ── Sidebar ──
let sidebarOpen = $state(true);
let sidebarWidth = $state(240);
// In-app floating mode: when true, AppShell renders the vault sidebar
// inside a draggable `FloatingVaultPanel` instead of the docked column.
// Replaces the legacy second-BrowserWindow pop-out implementation.
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

// Phase 31 B5.1 — side-channel context for the Re-link modal so the
// keyless `openModal('relink-tile')` API doesn't need to thread the tile
// id + compatible extension list through its argument shape.
interface RelinkContext { tileId: string; expectedTypes: string[] }
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
}

let confirmDialog = $state<ConfirmDialogConfig | null>(null);

// ── Sidebar pending-rename signal ──
//
// Phase C / C.7 — when the user clicks "New Folder" in the sidebar
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
}

let toasts = $state<ToastMessage[]>([]);
let toastCounter = 0;
const toastTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

/**
 * Every toast auto-dismisses after at most this long — including the
 * external-edit decision toasts that historically passed `duration: 0`
 * to stay on screen until the user picked Reload / Keep. Auto-dismiss is
 * the non-destructive default: the lossy "Reload / discard" choice always
 * requires an explicit click, so a toast timing out only ever keeps the
 * user's in-memory state (the two write-blocking promise toasts resolve
 * to 'keep-local' on dismiss — see vaultExternalChanges.ts). Capping the
 * persistent toasts here stops a re-firing conflict prompt from blanketing
 * the screen indefinitely.
 */
const TOAST_MAX_LIFETIME_MS = 15000;

export const uiStore = {
  // Sidebar
  get sidebarOpen() { return sidebarOpen; },
  toggleSidebar() { sidebarOpen = !sidebarOpen; },

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
    // Phase 31 B5.1 — drop the per-modal side-channel state on close so a
    // subsequent open of the relink modal doesn't inherit the prior
    // tile's context.
    relinkContext = null;
  },
  isModalOpen(id: string) { return activeModal === id; },

  // Phase 31 B5.1 — relink modal context.
  get relinkContext() { return relinkContext; },
  openRelinkModal(tileId: string, expectedTypes: string[]) {
    relinkContext = { tileId, expectedTypes };
    activeModal = 'relink-tile';
  },

  // Confirm dialog
  get confirmDialog() { return confirmDialog; },
  openConfirm(config: ConfirmDialogConfig) { confirmDialog = config; },
  closeConfirm() { confirmDialog = null; },

  // Phase C / C.7 — sidebar pending-rename signal.
  get pendingSidebarRenameId() { return pendingSidebarRenameId; },
  setPendingSidebarRenameId(id: string | null) { pendingSidebarRenameId = id; },

  // Context Menu
  get contextMenu() { return contextMenu; },
  showContextMenu(x: number, y: number, items: ContextMenuItem[], context?: unknown) {
    // Pre-paint estimate only — a store can't measure the unmounted menu, so
    // this rough clamp (assumed 200px wide, ~32px/row) keeps the first frame
    // from rendering wildly off-screen. ContextMenu.svelte re-clamps against
    // the menu's *measured* size on mount (L4b), which is authoritative.
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
   * modal dismisses on its own without also closing the modal beneath it
   * (H1). Mirrors ConfirmDialog's own cancel by firing the confirm's
   * `onCancel`. Returns which layer closed, or null when nothing was open.
   */
  cancelTopLayer(): 'confirm' | 'modal' | 'context-menu' | null {
    if (confirmDialog) {
      const cfg = confirmDialog;
      confirmDialog = null;
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
  }): string {
    // E.4 — cap the visible queue at 8 so an error storm (e.g. a tag-rename
    // sweep hitting an EPERM directory) can't paint the entire viewport.
    // Prefer dropping the oldest non-error first so error breadcrumbs stay
    // visible; if everything queued is an error, drop the oldest error.
    const TOAST_CAP = 8;
    while (toasts.length >= TOAST_CAP) {
      const nonError = toasts.find((t) => t.type !== 'error');
      const victim = nonError ?? toasts[0];
      this.dismissToast(victim.id, { silent: true });
    }

    const id = `toast-${++toastCounter}`;
    const toast: ToastMessage = {
      id,
      text: opts.text,
      type: opts.type ?? 'info',
      duration: opts.duration ?? TOAST_MAX_LIFETIME_MS,
      actions: opts.actions,
      onDismiss: opts.onDismiss,
    };
    toasts = [...toasts, toast];

    // Always schedule a dismissal. A positive duration is honoured (capped at
    // the max lifetime); `0`/unset — the old "persistent" sentinel — now maps
    // to the 15s cap so even decision toasts time out instead of lingering.
    const lifetime =
      toast.duration && toast.duration > 0
        ? Math.min(toast.duration, TOAST_MAX_LIFETIME_MS)
        : TOAST_MAX_LIFETIME_MS;
    const timer = setTimeout(() => {
      toastTimers.delete(id);
      this.dismissToast(id);
    }, lifetime);
    toastTimers.set(id, timer);

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
      try {
        const result = action.handler();
        // Catch the rejection of async handlers so the user sees the failure
        // in the dev console (and the unhandled-rejection logger doesn't fire).
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => console.error('[Toast] Action failed:', err));
        }
      } catch (err) {
        console.error('[Toast] Action failed:', err);
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
};

// Sprint B / B14 — drop transient UI state when the vault swaps so a toast,
// open modal, context menu, or confirm dialog from the prior vault can't
// stay visible (or fire its callback against a now-unmounted backing
// store) after the new vault opens. Sidebar geometry stays — it's per
// machine, not per vault.
onVaultSwap('pre-swap', 'ui', () => {
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
  toasts = [];
  contextMenu = { visible: false, x: 0, y: 0, items: [] };
  activeModal = null;
  relinkContext = null;
  // Audit 3.1 — fire the confirm dialog's onCancel before clearing it.
  // A pending `confirmCloseAnyway` (awaited inside tabStore.close /
  // closeOthers) resolves ONLY via onConfirm/onCancel; nulling the dialog
  // directly left that promise unresolved, suspending the close() forever
  // and stranding a phantom tab. Mirrors cancelTopLayer's confirm branch.
  if (confirmDialog) {
    const cfg = confirmDialog;
    confirmDialog = null;
    cfg.onCancel?.();
  }
  pendingSidebarRenameId = null;
});
