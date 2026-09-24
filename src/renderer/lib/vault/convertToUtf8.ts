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
import { readMarkdownForHydrate } from './markdownFileWriter';
import { captureVaultIdentity, isStillSameVault } from './vaultIdentity';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';

/**
 * Re-reads the converted note (fresh drift baseline + UTF-8 flag) and reloads
 * every open view of it: their text still holds the U+FFFD-decoded version.
 */
async function reloadConvertedNote(vaultRoot: string, relPath: string): Promise<void> {
  const identity = captureVaultIdentity();
  const fresh = await readMarkdownForHydrate(vaultRoot, relPath);
  if (!isStillSameVault(identity)) return;
  await vaultIndexStore.applyChanges([relPath]);
  if (!isStillSameVault(identity)) return;
  const doc = documentStore.findByFilename(relPath);
  if (doc) {
    documentStore.applyReloadFromDisk(doc.docId, fresh.body, doc.richText, fresh.frontmatter, fresh.rawFrontmatter, {
      mtimeMs: fresh.mtimeMs,
      size: fresh.size,
    });
  }
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
          await reloadConvertedNote(vaultRoot, relPath);
          uiStore.pushToast({ text: `Converted "${relPath}" to UTF-8. The original is in .filo/recovery/.`, type: 'success', duration: 6000 });
          onConverted?.();
        } catch (err) {
          const utf16 = err instanceof IpcEnvelopeError && err.code === 'UTF16';
          reportError(
            'convertToUtf8',
            err,
            utf16
              ? `"${relPath}" is UTF-16 text, which Filo can't convert automatically. Re-save it as UTF-8 in another editor.`
              : `Couldn't convert "${relPath}" to UTF-8. The file was not changed.`,
          );
        }
      })();
    },
  });
}
