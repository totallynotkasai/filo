/**
 * Keyboard shortcut registry.
 *
 * Shortcuts are registered globally with a default binding. When a `commandId`
 * is provided, the binding can be overridden by the user via the Keyboard
 * Shortcuts settings panel — overrides persist to `.filo/hotkeys.json`.
 *
 * Override application is reactive: changing the override map at any point
 * re-applies bindings to all currently registered shortcuts that share a
 * command id.
 */
import { scheduleMiscWrite, markCorruptConfigTarget } from '../lib/boards/boardSaver';
import { isConfigLoadFailed } from '../lib/boards/configWriteScheduler';
import { CONFIG_LOAD_RETRY_DELAYS_MS } from '../lib/vault/vaultCandidate';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';

/** Shape of `.filo/hotkeys.json` — a flat command-id → shortcut-string map. */
type HotkeysConfig = Record<string, string>;

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Shortcut extends ShortcutBinding {
  /** Unique command id (verb:noun). Required for user-customisable shortcuts. */
  commandId?: string;
  /** Action invoked when the shortcut fires. */
  action: () => void;
  /** Human-readable label shown in the shortcuts panel. */
  description: string;
  /**
   * Allows the shortcut to fire when the focus is inside a `contenteditable`
   * element (typically a Tiptap editor). Required for editor-targeted
   * commands like Insert Link, since the global handler otherwise skips
   * shortcuts to keep editor typing unaffected. Note: INPUT and TEXTAREA
   * elements always block — `allowInEditor` only relaxes the
   * contenteditable filter.
   */
  allowInEditor?: boolean;
  /**
   * Optional gate deciding whether this shortcut is currently eligible to
   * fire. When it returns `false` the global handler SKIPS this shortcut and
   * keeps scanning, so another shortcut bound to the same key combo can still
   * match. This is what lets two board panes register the same bare key (e.g.
   * `n`) in a split view and have it route to the focused pane — each board
   * gates its binding on "is my pane the active one". Distinct from a no-op
   * action: a skipped shortcut does not `preventDefault`, so the keystroke
   * falls through to the next match (or the browser) instead of being eaten.
   */
  enabled?: () => boolean;
}

interface RegisteredShortcut extends Shortcut {
  /** The original key combo used at registration time (kept so we can reset). */
  defaultBinding: ShortcutBinding;
}

const shortcuts: RegisteredShortcut[] = [];
let initialized = false;

/** Map of `commandId` → user override binding. Loaded from `.filo/hotkeys.json`. */
let overrides: Record<string, ShortcutBinding> = {};

/**
 * The vault whose `hotkeys.json` couldn't be read at open (a lock), and the
 * shortcut changes made since. The file is read again before the first
 * write, and those changes go on top of what it holds, so a write never
 * replaces bindings Filo hasn't read. Set and cleared by each vault's load.
 */
// allow-module-state: replaced by loadHotkeyOverrides on every vault open
let unreadHotkeysVault: string | null = null;
// allow-module-state: replaced by loadHotkeyOverrides on every vault open
const unreadChanges = new Map<string, ShortcutBinding | null>();

// ── Key event matching ──

function bindingMatches(binding: ShortcutBinding, e: KeyboardEvent): boolean {
  const ctrlMatch = binding.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
  const shiftMatch = binding.shift ? e.shiftKey : !e.shiftKey;
  const altMatch = binding.alt ? e.altKey : !e.altKey;
  return e.key.toLowerCase() === binding.key.toLowerCase() && ctrlMatch && shiftMatch && altMatch;
}

function handleKeyDown(e: KeyboardEvent) {
  // Don't intercept if user is typing in an input/textarea/contenteditable —
  // form INPUT/TEXTAREA always block (only Escape passes through). Inside a
  // contenteditable (e.g. a Tiptap editor) shortcuts may opt in via
  // `allowInEditor` so editor-targeted commands like Insert Link can fire
  // without the user having to defocus the editor first.
  const target = e.target as HTMLElement;
  const inFormInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
  const inContentEditable = target.isContentEditable;

  if (inFormInput && e.key !== 'Escape') return;

  for (const shortcut of shortcuts) {
    if (bindingMatches(shortcut, e)) {
      if (inContentEditable && e.key !== 'Escape' && !shortcut.allowInEditor) continue;
      // Skip (don't fire, don't preventDefault) so a same-binding shortcut
      // registered by the active pane can still match — see `enabled` above.
      if (shortcut.enabled && !shortcut.enabled()) continue;
      e.preventDefault();
      shortcut.action();
      return;
    }
  }
}

/**
 * Initializes the global keyboard listener. Call once on app mount.
 */
export function initKeyboardShortcuts(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('keydown', handleKeyDown);
}

// ── Binding helpers ──

function applyOverrideTo(s: RegisteredShortcut): void {
  const override = s.commandId ? overrides[s.commandId] : undefined;
  if (override) {
    s.key = override.key;
    s.ctrl = override.ctrl ?? false;
    s.shift = override.shift ?? false;
    s.alt = override.alt ?? false;
  } else {
    s.key = s.defaultBinding.key;
    s.ctrl = s.defaultBinding.ctrl ?? false;
    s.shift = s.defaultBinding.shift ?? false;
    s.alt = s.defaultBinding.alt ?? false;
  }
}

/**
 * Registers a keyboard shortcut. Returns an unregister function.
 *
 * If `commandId` is provided, the binding may be overridden by `.filo/hotkeys.json`;
 * the original key combo is retained as the default for reset.
 */
export function registerShortcut(shortcut: Shortcut): () => void {
  const registered: RegisteredShortcut = {
    ...shortcut,
    defaultBinding: {
      key: shortcut.key,
      ctrl: shortcut.ctrl,
      shift: shortcut.shift,
      alt: shortcut.alt,
    },
  };
  applyOverrideTo(registered);
  shortcuts.push(registered);
  return () => {
    const idx = shortcuts.indexOf(registered);
    if (idx >= 0) shortcuts.splice(idx, 1);
  };
}

/**
 * Returns all registered shortcuts (for display in the shortcuts modal).
 */
export function getAllShortcuts(): Shortcut[] {
  return shortcuts.map((s) => ({ ...s }));
}

/**
 * Returns the default binding (key combo at registration time) for a command id.
 * Useful for the rebind UI's "reset to default" button.
 */
export function getDefaultBinding(commandId: string): ShortcutBinding | null {
  const s = shortcuts.find((s) => s.commandId === commandId);
  return s ? { ...s.defaultBinding } : null;
}

// ── Overrides ──

/**
 * Replaces all hotkey overrides at once. Applied to every matching registered
 * shortcut. Pass an empty object to clear all overrides.
 */
export function setHotkeyOverrides(next: Record<string, ShortcutBinding>): void {
  overrides = { ...next };
  for (const s of shortcuts) applyOverrideTo(s);
}

/**
 * Returns the currently applied override map (commandId → binding).
 */
export function getHotkeyOverrides(): Record<string, ShortcutBinding> {
  return { ...overrides };
}

/**
 * Sets the override for a single command id and re-applies it. Pass `null` to
 * clear an override (resets to the default binding).
 */
export function setHotkeyOverride(commandId: string, binding: ShortcutBinding | null): void {
  if (binding) {
    overrides[commandId] = { ...binding };
  } else {
    delete overrides[commandId];
  }
  if (unreadHotkeysVault !== null) unreadChanges.set(commandId, binding ? { ...binding } : null);
  for (const s of shortcuts) {
    if (s.commandId === commandId) applyOverrideTo(s);
  }
}

/**
 * Returns the commandId of any *other* registered shortcut whose effective
 * binding matches `binding`, or null if no conflict. Used by the rebind UI to
 * block duplicates.
 */
export function findBindingConflict(binding: ShortcutBinding, exceptCommandId?: string): string | null {
  for (const s of shortcuts) {
    if (s.commandId === exceptCommandId) continue;
    if (
      s.key.toLowerCase() === binding.key.toLowerCase() &&
      Boolean(s.ctrl) === Boolean(binding.ctrl) &&
      Boolean(s.shift) === Boolean(binding.shift) &&
      Boolean(s.alt) === Boolean(binding.alt)
    ) {
      return s.commandId ?? s.description;
    }
  }
  return null;
}

// ── Format helpers ──

/**
 * Formats a binding for display, e.g. "Ctrl+Shift+N".
 */
export function formatShortcut(s: Pick<ShortcutBinding, 'key' | 'ctrl' | 'shift' | 'alt'>): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push('Ctrl');
  if (s.shift) parts.push('Shift');
  if (s.alt) parts.push('Alt');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join('+');
}

/**
 * Parses a shortcut string like "Ctrl+Shift+N" back into a binding. Returns
 * null on a malformed string.
 */
export function parseShortcut(str: string): ShortcutBinding | null {
  if (!str) return null;
  const parts = str.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const binding: ShortcutBinding = { key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') binding.ctrl = true;
    else if (lower === 'shift') binding.shift = true;
    else if (lower === 'alt' || lower === 'opt' || lower === 'option') binding.alt = true;
    else binding.key = part;
  }
  return binding.key ? binding : null;
}

/**
 * Captures a binding from a KeyboardEvent. Skips pure modifier-only events
 * (Ctrl alone, Shift alone, etc.) — returns null in that case.
 */
export function bindingFromEvent(e: KeyboardEvent): ShortcutBinding | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  return {
    key: e.key,
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

// ── Hotkeys.json round-trip ──

/**
 * Converts the override map to the on-disk shape (commandId → "Ctrl+Shift+N").
 */
export function serializeOverrides(map: Record<string, ShortcutBinding>): HotkeysConfig {
  const out: HotkeysConfig = {};
  for (const [cmd, binding] of Object.entries(map)) {
    out[cmd] = formatShortcut(binding);
  }
  return out;
}

/**
 * Converts the on-disk shape back to a binding map. Skips invalid strings.
 */
export function deserializeOverrides(config: HotkeysConfig): Record<string, ShortcutBinding> {
  const out: Record<string, ShortcutBinding> = {};
  for (const [cmd, str] of Object.entries(config)) {
    const binding = parseShortcut(str);
    if (binding) out[cmd] = binding;
  }
  return out;
}

/**
 * Loads overrides from `.filo/hotkeys.json` into memory and applies them. Safe
 * to call before any shortcuts are registered — overrides are stored and
 * applied to shortcuts that register later.
 */
export async function loadHotkeyOverrides(
  vaultRoot: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const identity = captureVaultIdentity();
  try {
    // A transient lock (OneDrive, antivirus) usually clears within a second.
    let loaded = await window.filo.invoke('config:load', vaultRoot, 'hotkeys.json');
    for (const delay of CONFIG_LOAD_RETRY_DELAYS_MS) {
      if (!isConfigLoadFailed(loaded)) break;
      await sleep(delay);
      if (!isStillSameVault(identity)) return;
      loaded = await window.filo.invoke('config:load', vaultRoot, 'hotkeys.json');
    }
    if (!isStillSameVault(identity)) return;
    unreadHotkeysVault = null;
    unreadChanges.clear();
    const corrupt = !!loaded && typeof loaded === 'object' && '__corrupt' in loaded;
    // Installing empty overrides here would let the next rebind write a
    // one-entry hotkeys.json over every other custom binding. Keep what is in
    // memory instead.
    if (corrupt) {
      // Unreadable JSON stays unreadable: stop hotkey writes for this session.
      markCorruptConfigTarget('hotkeys.json');
      reportError(
        'hotkeys.load-overrides',
        null,
        "Couldn't read .filo/hotkeys.json — shortcut changes won't be saved this session",
      );
      return;
    }
    if (isConfigLoadFailed(loaded)) {
      // Locked (a sync client, antivirus): the next shortcut change reads it
      // again before it writes, and waits for Retry while it stays locked.
      unreadHotkeysVault = vaultRoot;
      reportError(
        'hotkeys.load-overrides',
        null,
        "Couldn't read .filo/hotkeys.json (it may be locked). Filo reads it again before saving a shortcut change.",
      );
      return;
    }
    setHotkeyOverrides(deserializeOverrides((loaded ?? {}) as HotkeysConfig));
  } catch (err) {
    reportError(
      'hotkeys.load-overrides',
      err,
      'Failed to load keyboard shortcut overrides from .filo/hotkeys.json — defaults will apply',
    );
  }
}

/**
 * Persists the current override map to `.filo/hotkeys.json` via the shared
 * misc-write scheduler so rapid sequential rebinds (the Keyboard Shortcuts
 * settings panel captures one combo at a time) coalesce into a single
 * disk write. Participates in the inflight / sentinel / write-error
 * pipeline like the rest of the `.filo/` configs.
 */
export function saveHotkeyOverrides(vaultRoot: string): void {
  scheduleMiscWrite('hotkeys', () => {
    if (!vaultRoot) return null;
    // Re-serialize at flush time so the write captures the latest override
    // map, not the snapshot at schedule time.
    const payload = serializeOverrides(overrides);
    return {
      vaultRoot,
      path: '.filo/hotkeys.json',
      json: JSON.stringify(payload, null, 2),
      write: async () => {
        if (unreadHotkeysVault === vaultRoot) {
          await readHotkeysBeforeWrite(vaultRoot);
          await invokeOk('config:save', vaultRoot, 'hotkeys.json', serializeOverrides(overrides));
          return;
        }
        await invokeOk('config:save', vaultRoot, 'hotkeys.json', payload);
      },
    };
  });
}

/**
 * Reads the `hotkeys.json` a lock kept from the open, and puts this session's
 * shortcut changes on top of it. Throws (EBUSY, kept for Retry) while it is
 * still locked, and CONFIG_CORRUPT when it turns out unreadable.
 */
async function readHotkeysBeforeWrite(vaultRoot: string): Promise<void> {
  const loaded = await window.filo.invoke('config:load', vaultRoot, 'hotkeys.json');
  if (unreadHotkeysVault !== vaultRoot) return;
  if (isConfigLoadFailed(loaded)) {
    throw Object.assign(
      new Error("Couldn't read .filo/hotkeys.json before saving your shortcut change (it may be locked)."),
      { code: 'EBUSY' },
    );
  }
  if (!!loaded && typeof loaded === 'object' && '__corrupt' in loaded) {
    unreadHotkeysVault = null;
    unreadChanges.clear();
    markCorruptConfigTarget('hotkeys.json');
    throw Object.assign(new Error('.filo/hotkeys.json is unreadable, so shortcut changes are not being saved.'), {
      code: 'CONFIG_CORRUPT',
    });
  }
  const merged = deserializeOverrides((loaded ?? {}) as HotkeysConfig);
  for (const [commandId, binding] of unreadChanges) {
    if (binding) merged[commandId] = binding;
    else delete merged[commandId];
  }
  unreadHotkeysVault = null;
  unreadChanges.clear();
  setHotkeyOverrides(merged);
}

/** Internal — for tests only. Resets the registry to a clean state. */
export function _resetForTests(): void {
  shortcuts.length = 0;
  overrides = {};
  unreadHotkeysVault = null;
  unreadChanges.clear();
  if (initialized && typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeyDown);
  }
  initialized = false;
}
