import { dialog, type BrowserWindow, type RenderProcessGoneDetails } from 'electron';
import { logMainError } from '../utils/mainLogger';

/**
 * Handles a renderer that died (OOM, GPU crash, killed) instead of leaving a
 * blank window.
 *
 * On `render-process-gone` the preserved-partials breadcrumb is written from
 * main (the emergency-file registry is main-side state, so it survives the
 * renderer), then the user chooses **Reload** (the vault reopens and the
 * `.dirty` recovery flow runs as on a fresh launch) or **Quit**. Reload first
 * releases the vault in main: the reloaded page starts with no vault open, and
 * main must agree, or it would refuse to open any other vault until a restart. While the
 * renderer is gone, window close and app quit skip the flush-and-quit drain:
 * there is no renderer to drain, so waiting would only hang a blank window
 * for the drain timeout.
 *
 * `unresponsive` is only logged. Offering Reload for a merely hung renderer
 * would discard its in-flight writes, and the drain heartbeat already bounds
 * a quit from a hung renderer.
 */

export interface RendererCrashDeps {
  /** Writes the preserved-partials breadcrumb for the current vault. */
  writeBreadcrumb: () => Promise<void>;
  /** A quit drain is already running: close instead of asking. */
  isQuitting: () => boolean;
  /** Lets the open vault go (watcher, registry), as closing it does. */
  releaseVault: () => Promise<void>;
}

let rendererGone = false;

/** True between a `render-process-gone` and the next successful page load. */
export function isRendererGone(): boolean {
  return rendererGone;
}

export function attachRendererCrashHandlers(win: BrowserWindow, deps: RendererCrashDeps): void {
  const wc = win.webContents;

  wc.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
    if (details.reason === 'clean-exit') return;
    rendererGone = true;
    logMainError('renderer:gone', details);
    void (async () => {
      await deps.writeBreadcrumb().catch((err: unknown) => logMainError('renderer:gone breadcrumb', err));
      if (win.isDestroyed()) return;
      if (deps.isQuitting()) {
        win.destroy();
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        message: "Filo's window stopped working",
        detail:
          `Reason: ${details.reason}. Changes typed in the last moment may not have been saved; ` +
          'reopening the vault will offer recovery.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (win.isDestroyed()) return;
      if (response !== 0) {
        win.destroy();
        return;
      }
      await deps.releaseVault().catch((err: unknown) => logMainError('renderer:gone release', err));
      if (!win.isDestroyed()) wc.reload();
    })();
  });

  wc.on('did-finish-load', () => {
    rendererGone = false;
  });

  wc.on('unresponsive', () => {
    logMainError('renderer:unresponsive', new Error('renderer stopped responding'));
  });

  wc.on('responsive', () => {
    console.warn('[main] renderer is responsive again');
  });
}

export function __resetRendererCrashStateForTests(): void {
  rendererGone = false;
}
