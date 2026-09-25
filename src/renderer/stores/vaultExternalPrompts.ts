/**
 * Vault slice — external-change USER PROMPTS for files other than open notes:
 * an attachment or a note deleted outside Filo while tiles still point at it.
 * (A loaded note's own conflict prompts live in `notePrompts.ts`.)
 *
 * Dependency direction: the dispatcher in `vaultExternalChanges.ts` imports
 * these builders; nothing here imports back into it. Every builder takes the
 * already-captured vault root as an argument.
 */
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from './ui.svelte';

/**
 * Toast for an external delete of an attachment file
 * (image/video/audio/pdf/etc.) referenced by at least one tile, cover image,
 * or frame background. Same shape as `promptClosedBoardFileMissing` but
 * names the attachment basename so the user can scan the toast at a glance.
 *
 * On confirm: routes through the existing undoable cascade so Ctrl+Z still
 * restores placements. `fileSnapshots` is empty because the file is
 * already gone — undo restores tiles but not bodies.
 */
export function promptExternalAttachmentDeleted(
  rel: string,
  tileCount: number,
  // Anchors the cascade command's vault-swap guard.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" was deleted externally — ${tileCount} reference${tileCount === 1 ? '' : 's'} (tiles, cover images, frame backgrounds) on existing boards now point at a missing file.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `missing:${rel}`,
    actions: [
      {
        label: 'Remove references',
        // Behind a danger confirm listing the boards, with a click-time
        // re-probe: a synthesised rename or trash restore can bring the file
        // back. Attachments keep their tags (fileTags drop is the .md path's
        // concern).
        handler: () => confirmRemoveTilesForMissingFile(rel, vaultRoot, false),
      },
      {
        label: 'Dismiss',
        handler: () => {
          // No-op — leaves the broken refs in place so the user can attempt
          // a restore (e.g. recover from trash) without losing tile layout.
        },
      },
    ],
  });
}

/**
 * What a vault-wide "remove the tiles for a missing file"
 * cascade would touch, computed at toast / confirm time so the copy names the
 * real scope (it spans EVERY board, open ones included — not "closed boards").
 */
function describeMissingFileScope(rel: string): { tiles: number; boardNames: string[] } {
  const targets = boardCacheStore.findCascadeDeleteTargets(rel);
  const boardNames = Object.entries(targets.byBoard)
    .filter(([, ids]) => ids.length > 0)
    .map(([boardId]) => boardCacheStore.cache[boardId]?.board.name || boardId);
  return { tiles: targets.tileIds.length, boardNames };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The cascade is destructive and vault-wide, and its undo lands on whichever
 * board is active, so it only ever runs behind an explicit danger confirm that
 * lists the boards. A click-time re-probe skips it when the file is back on
 * disk (a synced move / trash restore).
 */
function confirmRemoveTilesForMissingFile(rel: string, vaultRoot: string, dropTags: boolean): void {
  const { tiles, boardNames } = describeMissingFileScope(rel);
  if (tiles === 0) return;
  uiStore.openConfirm({
    title: 'Remove tiles for a missing file?',
    body: `This removes ${plural(tiles, 'tile')} and their connections from ${plural(boardNames.length, 'board')}: ${boardNames.join(', ')}. The file itself is already missing. Undo is available on the board that is active when you confirm.`,
    confirmLabel: 'Remove tiles',
    danger: true,
    onConfirm: () => {
      void (async () => {
        try {
          const exists = await window.filo.invoke('vault:file-exists', vaultRoot, rel);
          if (exists) return;
        } catch {
          // Probe failure → treat as still-missing; fall through.
        }
        // The undoable cascade; the file itself is already gone.
        boardStore.cascadeDeleteByVaultPath(rel, { vaultRoot });
        // The user confirmed the file is gone; drop its tags.json
        // membership so the orphan entry doesn't linger.
        if (dropTags) fileTagsStore.dropFile(rel);
      })().catch((err) => reportError('missingFile.removeTiles', err, 'Removing the tiles failed.'));
    },
  });
}

/**
 * Toast for an external delete of a `.md`
 * referenced by tiles, with NO open editor for it. On a synced vault this fires
 * for moves and delete-then-recreate too, so the DEFAULT does nothing: "Keep
 * tiles" leaves them showing as missing (the boardRefIntegrity badge is the
 * signal). "Remove N tiles from boards…" opens a danger confirm that lists the
 * boards; only then does the vault-wide cascade run. Sticky + keyed per file,
 * and dismissed when the file reappears (vaultExternalChanges).
 */
export function promptClosedBoardFileMissing(
  rel: string,
  tileCount: number,
  // Anchors the cascade command's vault-swap guard.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  const { boardNames } = describeMissingFileScope(rel);
  uiStore.pushToast({
    text: `"${filename}" is missing from the vault (deleted or moved outside Filo). ${plural(tileCount, 'tile')} on ${plural(boardNames.length, 'board')} now show as missing.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `missing:${rel}`,
    actions: [
      {
        label: 'Keep tiles (show as missing)',
        handler: () => {
          // No-op by design: the tiles keep their broken-ref badge.
        },
      },
      {
        label: `Remove ${plural(tileCount, 'tile')} from boards…`,
        handler: () => confirmRemoveTilesForMissingFile(rel, vaultRoot, true),
      },
    ],
  });
}
