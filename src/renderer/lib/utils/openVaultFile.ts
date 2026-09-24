import { asSafeOpenExternal, launcherExtension } from '../../../shared/untrusted';
import { IpcEnvelopeError } from '../../../shared/ipcEnvelope';
import { invokeOk } from './invokeOk';
import { reportError } from './errorBus';
import { uiStore } from '../../stores/ui.svelte';

/**
 * Opens an in-vault file with its OS default app. Only allowlisted
 * document/media types are handed to the OS (`OPEN_PATH_ALLOWED_EXTENSIONS`;
 * main re-checks). Anything else — a script, an archive, an HTML page — gets
 * a toast offering "Show in folder" instead, which selects the file in the
 * OS file manager without running it.
 */
export async function openVaultFileExternally(absPath: string, displayName: string): Promise<void> {
  const safe = asSafeOpenExternal(absPath);
  if (!safe) {
    offerShowInFolder(absPath);
    return;
  }
  try {
    await invokeOk('media:open-external', safe);
  } catch (err) {
    if (err instanceof IpcEnvelopeError && err.code === 'EXTENSION_NOT_ALLOWED') {
      offerShowInFolder(absPath);
      return;
    }
    reportError('FileTile.open', err, `Failed to open ${displayName} externally`);
  }
}

function offerShowInFolder(absPath: string): void {
  const ext = launcherExtension(absPath);
  const what = ext ? `"${ext}" files` : 'files without an extension';
  uiStore.pushToast({
    text: `Filo doesn't open ${what} directly.`,
    type: 'warning',
    actions: [
      {
        label: 'Show in folder',
        handler: () => {
          void window.filo.invoke('shell:show-item-in-folder', absPath);
        },
      },
    ],
  });
}
