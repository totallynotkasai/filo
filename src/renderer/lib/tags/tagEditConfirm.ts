import { uiStore } from '../../stores/ui.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';

/**
 * Confirm-then-run wrappers for the vault-wide tag actions in the Tags
 * browser. They use the in-app ConfirmDialog, never the native `confirm()`,
 * which blocks the renderer event loop (and every debounced write timer with
 * it) and can't say what the change will touch.
 */

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Deletes `name` from every note, tile and attachment after a danger confirm
 * that says how much it touches. Resolves `true` when the delete ran.
 */
export async function deleteTagWithConfirm(name: string): Promise<boolean> {
  const files = fileTagsStore.filesForTag(name).length;
  const tiles = fileTagsStore.getTilesWithTag(name).length;
  const ok = await uiStore.confirmAsync({
    title: `Delete tag "#${name}"?`,
    body:
      `Removes the tag from ${plural(files, 'file')} and ${plural(tiles, 'tile')} across every board. ` +
      "This can't be undone.",
    confirmLabel: 'Delete tag',
    danger: true,
  });
  if (!ok) return false;
  await fileTagsStore.removeTagEverywhere(name);
  return true;
}

/**
 * Renames `oldName` to `newName` everywhere. Asks first only when the rename
 * has a consequence the user can't see from the input field:
 *   - `newName` already exists → the two tags MERGE, and renaming back won't
 *     split them again;
 *   - `oldName` has child tags (`old/…`), which don't follow the rename.
 * A plain rename to a new name runs without a dialog.
 */
export async function renameTagWithConfirm(oldName: string, newName: string): Promise<boolean> {
  const all = fileTagsStore.allTagNames();
  const merging = all.includes(newName);
  const prefix = `${oldName}/`;
  const children = all.filter((n) => n.startsWith(prefix));
  if (merging || children.length > 0) {
    const parts: string[] = [];
    if (merging) {
      parts.push(`"#${newName}" already exists, so the two tags will be merged. This can't be undone.`);
    }
    if (children.length > 0) {
      const shown = children.slice(0, 5).map((n) => `• ${n}`).join('\n');
      const extra = children.length > 5 ? `\n…and ${children.length - 5} more` : '';
      parts.push(
        `${plural(children.length, 'child tag')} won't be renamed (nested tags don't cascade):\n` +
          `${shown}${extra}\n` +
          `They'll stay under "${oldName}/…" until you rename them individually.`,
      );
    }
    const ok = await uiStore.confirmAsync({
      title: merging ? `Merge "#${oldName}" into "#${newName}"?` : `Rename "#${oldName}" to "#${newName}"?`,
      body: parts.join('\n\n'),
      confirmLabel: merging ? 'Merge tags' : 'Rename',
      danger: merging,
    });
    if (!ok) return false;
  }
  await fileTagsStore.renameTagEverywhere(oldName, newName);
  return true;
}
