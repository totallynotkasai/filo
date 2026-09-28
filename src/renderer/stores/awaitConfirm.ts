/**
 * awaitConfirm — `uiStore.openConfirm` as a promise, for the steps of the
 * recovery sequencer that must run one after another.
 */
import { uiStore } from './ui.svelte';

/**
 * Promisifies `uiStore.openConfirm` (true on Confirm, false on Cancel); the
 * original callbacks still fire. Async `onConfirm` / `onCancel` are AWAITED
 * before resolving, so the sequencer's next step can't start mid-flight (two
 * recoveries mutating the board cache concurrently).
 */
export function awaitConfirm(config: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}): Promise<boolean> {
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: config.title,
      body: config.body,
      confirmLabel: config.confirmLabel,
      cancelLabel: config.cancelLabel,
      danger: config.danger,
      onConfirm: async () => {
        try {
          await config.onConfirm?.();
        } finally {
          resolve(true);
        }
      },
      onCancel: async () => {
        try {
          await config.onCancel?.();
        } finally {
          resolve(false);
        }
      },
    });
  });
}
