/**
 * CommandRegistry — keyboard shortcut binding surface.
 *
 * Today this file exists to bind keyboard shortcuts via `registerShortcut`
 * (see `core/hotkeys.ts`) using a uniform verb:noun naming scheme. Feature
 * surfaces (AppShell, list-style boards) call `registerCommandWithShortcut`
 * so every shortcut-bound action has a stable command name that can later
 * be reused by a palette, menu, or context-menu dispatcher.
 *
 * Shortcut bindings only — no command palette yet. Add `registerCommand` /
 * `unregisterCommand` (with a Map<name, handler>) when a palette is built.
 */

import { registerShortcut, type ShortcutBinding } from './hotkeys';

/**
 * Binds a keyboard shortcut and returns a tear-down function.
 *
 * The shortcut binding may be overridden by the user via `.filo/hotkeys.json`
 * — see `core/hotkeys.ts` — so passing `name` as the shortcut's `commandId`
 * keeps overrides aligned with whatever palette entry might be added later.
 */
export interface CommandWithShortcutOptions {
  name: string;
  label: string;
  description: string;
  binding: ShortcutBinding;
  execute: () => void | Promise<void>;
  /**
   * Gates whether the shortcut may fire. Forwarded to the global key handler:
   * a disabled command is SKIPPED so another command sharing the same binding
   * (e.g. the same bare key registered by a different board pane) can still
   * match. See {@link Shortcut.enabled} in `core/hotkeys.ts`.
   */
  enabled?: () => boolean;
  /**
   * Forwards to {@link Shortcut.allowInEditor}. Required for editor-targeted
   * commands (Insert Link etc.) so the shortcut fires from inside a Tiptap
   * editor instead of being blocked by the contenteditable filter.
   */
  allowInEditor?: boolean;
}

export function registerCommandWithShortcut(opts: CommandWithShortcutOptions): () => void {
  const unregisterHotkey = registerShortcut({
    commandId: opts.name,
    key: opts.binding.key,
    ctrl: opts.binding.ctrl,
    shift: opts.binding.shift,
    alt: opts.binding.alt,
    description: opts.description,
    allowInEditor: opts.allowInEditor,
    // Routed to the key handler (not gated in the action) so a disabled
    // command is skipped and the loop keeps scanning for another match.
    enabled: opts.enabled,
    action: () => {
      void opts.execute();
    },
  });
  return () => {
    unregisterHotkey();
  };
}
