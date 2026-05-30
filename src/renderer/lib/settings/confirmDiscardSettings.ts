import type { uiStore as UIStore } from '../../stores/ui.svelte';
import type { pendingSettingsStore as PendingSettingsStore } from '../../stores/pendingSettings.svelte';

/**
 * Phase 1 / 1.1 — `Modal.beforeClose` callback for the Project Settings
 * modal. If the user has uncommitted edits in either tab, route them
 * through the in-app confirm dialog before letting the modal close.
 *
 * Returns:
 *   - `true`  → close is allowed; `ProjectSettings`'s mount-effect cleanup
 *               will call `pendingSettingsStore.cancel()`
 *   - `false` → close is blocked; the modal stays open and `cancel()` is
 *               never called, so the user's edits survive
 *
 * Extracted into a pure-function module so the close-guard contract is
 * testable without rendering the full Svelte component tree. The two
 * store arguments make the dependency on global state explicit and let
 * the unit test pass spy doubles.
 */
export async function confirmDiscardSettings(
  pending: typeof PendingSettingsStore,
  ui: typeof UIStore,
): Promise<boolean> {
  if (!pending.hasUnsavedChanges()) return true;
  return new Promise<boolean>((resolve) => {
    ui.openConfirm({
      title: 'Discard settings changes?',
      body: 'You have uncommitted changes in the Settings modal. Discarding will revert them.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
