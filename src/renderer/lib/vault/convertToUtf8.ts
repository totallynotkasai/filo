/**
 * The "Convert to UTF-8…" action shown on a non-UTF-8 note.
 *
 * Confirms first (naming Windows-1252 and the backup), then asks main to
 * snapshot the original bytes to `.filo/recovery/`, decode them as
 * Windows-1252 and write UTF-8 (`vault:convert-to-utf8`). On success the note
 * leaves the non-UTF-8 set; the caller re-reads it (`onConverted`).
 */
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { reportError } from '../utils/errorBus';
import { uiStore } from '../../stores/ui.svelte';
import { noteReadEncoding } from './nonUtf8Paths.svelte';
import { captureVaultIdentity, isStillSameVault } from './vaultIdentity';
import { noteStore } from '../../stores/notes.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';

/**
 * Re-reads the converted note (UTF-8 flag, vault index) and reloads its note
 * model, so every open view drops the U+FFFD-decoded text.
 */
async function reloadConvertedNote(relPath: string): Promise<void> {
  const identity = captureVaultIdentity();
  await vaultIndexStore.applyChanges([relPath]);
  if (!isStillSameVault(identity)) return;
  await noteStore.reload(relPath);
}

export function confirmConvertToUtf8(vaultRoot: string, relPath: string, onConverted?: () => void): void {
  uiStore.openConfirm({
    title: 'Convert this note to UTF-8?',
    body:
      `"${relPath}" isn't UTF-8 (it is probably Windows-1252). Filo will back up the original bytes to ` +
      '.filo/recovery/, re-read them as Windows-1252 and save the note as UTF-8. Other encodings may come out wrong; the backup lets you undo it.',
    confirmLabel: 'Convert to UTF-8',
    cancelLabel: 'Cancel',
    onConfirm: () => {
      void (async () => {
        try {
          await invokeOk('vault:convert-to-utf8', vaultRoot, relPath);
          noteReadEncoding(relPath, 'utf-8');
          await reloadConvertedNote(relPath);
          uiStore.pushToast({ text: `Converted "${relPath}" to UTF-8. The original is in .filo/recovery/.`, type: 'success', duration: 6000 });
          onConverted?.();
        } catch (err) {
          const code = err instanceof IpcEnvelopeError ? err.code : undefined;
          reportError(
            'convertToUtf8',
            err,
            code === 'UTF16'
              ? `"${relPath}" is UTF-16 text, which Filo can't convert automatically. Re-save it as UTF-8 in another editor.`
              : code === 'STALE'
                ? `"${relPath}" changed while Filo was converting it, so it was left as it is. Try again.`
                : code === 'NOTE_IS_LINK'
                  ? `"${relPath}" is a link to another file. Convert the original.`
                  : `Couldn't convert "${relPath}" to UTF-8. The file was not changed.`,
            relPath,
          );
        }
      })();
    },
  });
}
