/**
 * Undoable PropertiesPopup edits.
 *
 * One `UpdatePropertiesCommand` is pushed per popup session (when it closes
 * after the user touched a row); per-keystroke commands would blow through
 * MAX_HISTORY and don't match the user's mental model.
 *
 * Snapshots capture the metadata source for the tile's type:
 *  - text tiles → frontmatter (canonical source, lives on disk)
 *  - non-text tiles → `tile.metadata` (lives in board JSON)
 *
 * For text tiles the write targets the existing file only, so undo can't
 * resurrect an externally-deleted file. Pending frontmatter writes are drained
 * first so a rapid Apply → Undo can't race the still-debounced forward write.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { vaultStore } from '../stores/vault.svelte';
import type { Tile } from '../schema/index';
import {
  writeMarkdownFile,
  markHydrated,
  isHydrated,
  readMarkdownForHydrate,
} from '../lib/vault/markdownFileWriter';
import { markPathFailed } from '../lib/boards/writeStateTracking';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from '../stores/ui.svelte';
import { fmValueEqual } from './frontmatterRebase';
import { type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';

export type PropertiesSnapshot =
  | { kind: 'frontmatter'; relPath: string; notePath: string | null; fm: Record<string, unknown> }
  | { kind: 'metadata'; tileId: string; metadata: Record<string, unknown> };

export class UpdatePropertiesCommand extends Command {
  description: string;
  /**
   * The originating board: execute/undo always mark THIS board dirty, never
   * whichever board is active at redo time.
   */
  readonly targetBoardId: string;
  private before: PropertiesSnapshot;
  private after: PropertiesSnapshot;

  // allow-board-store-current: constructor fallback for callers that didn't capture an explicit boardId
  constructor(before: PropertiesSnapshot, after: PropertiesSnapshot, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.before = this.cloneSnapshot(before);
    this.after = this.cloneSnapshot(after);
    this.description = `Update properties`;
  }

  private cloneSnapshot(snap: PropertiesSnapshot): PropertiesSnapshot {
    if (snap.kind === 'frontmatter') {
      return {
        kind: 'frontmatter',
        relPath: snap.relPath,
        notePath: snap.notePath,
        // Detaches every nested key/value in the frontmatter map.
        fm: this.snapshot(snap.fm),
      };
    }
    return {
      kind: 'metadata',
      tileId: snap.tileId,
      metadata: this.snapshot(snap.metadata),
    };
  }

  async execute(): Promise<void> {
    // Pass BOTH legs so the frontmatter apply can rebase: it diffs
    // after-vs-before to learn which keys this command OWNS, then merges only
    // those onto the LIVE frontmatter, preserving any other (e.g. external) key.
    await applySnapshot(this.after, this.before, this.targetBoardId);
    // Dirty the ORIGINATING board, not whichever board is active at redo time.
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await applySnapshot(this.before, this.after, this.targetBoardId);
    boardCacheStore.markDirty(this.targetBoardId);
  }
}

/**
 * Removes empty / null / undefined values, matching `mergeFrontmatter`'s
 * cleaning rule (the user "clearing" a property deletes the key).
 */
function cleanFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === '' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Applies one leg of an `UpdatePropertiesCommand`.
 *
 * `target` is the snapshot this leg wants on disk; `other` is the opposite
 * leg's snapshot. For the metadata kind (non-text tiles → board JSON) the
 * snapshot is applied wholesale as before. For the frontmatter kind (text
 * tiles → `.md` YAML) it is REBASED:
 *
 *   - The keys this command OWNS = those that differ between the two legs.
 *   - It merges only those keys onto the LIVE base frontmatter (the open
 *     editor's cache, else a fresh disk read), so an untouched key — including
 *     one another tool added between the popup edit and Ctrl+Z — survives.
 *   - Conflicts: if an external edit moved an owned field away from what the
 *     opposite leg left it at, KEEP the external value and surface an
 *     "Apply anyway" toast (no silent clobber).
 */
async function applySnapshot(
  target: PropertiesSnapshot,
  other: PropertiesSnapshot,
  targetBoardId: string,
): Promise<void> {
  if (target.kind === 'metadata') {
    boardStore.updateTile(target.tileId, { metadata: { ...target.metadata } } as Partial<Tile>);
    return;
  }

  // Capture vault identity before the drain so the guards below bail on a
  // swap. A different-path swap is blocked main-side by assertActiveVault; this
  // also covers a close→reopen of the same path and the post-write bookkeeping.
  const identity = captureVaultIdentity();

  // Drain pending debounced writes before this command writes its own copy
  // so the prior in-memory state lands on disk first. Same reason as
  // UpdateCardFieldCommand: a rapid Apply → Undo without the flush would
  // race the still-debounced forward write against this command's fresh
  // write at the same path.
  await flushAllPendingFrontmatterWrites();

  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  if (!isStillSameVault(identity)) return; // swap during the drain

  const { relPath, notePath } = target;
  const targetFm = target.fm;
  const otherFm = other.kind === 'frontmatter' ? other.fm : {};

  // Keys this command owns = those that differ between the two legs. Untouched
  // keys are never in this set, so the merge below preserves them verbatim.
  const ownedKeys: string[] = [];
  for (const k of new Set([...Object.keys(targetFm), ...Object.keys(otherFm)])) {
    if (!fmValueEqual(otherFm[k], targetFm[k])) ownedKeys.push(k);
  }

  // Obtain the LIVE base frontmatter + body in as few reads as possible.
  //
  // Only an OPEN editor's FM cache is a trustworthy rebase base (the reconciler
  // keeps it fresh). A not-open doc's cache isn't refreshed, so rebasing onto
  // it would revert an externally-added key; re-read fresh disk instead (race-
  // free: pending writes were drained above). The index is the last resort.
  const docState = notePath ? documentStore.getDocument(notePath) : null;
  let base: Record<string, unknown> | null =
    docState && notePath ? documentStore.getFrontmatter(notePath) ?? null : null;
  let diskBody: string | undefined;
  // Track whether the hydrate read THREW so the no-baseline
  // branch below can tell "file genuinely has no FM" from "file unreadable".
  let readFailed = false;
  // Read disk when we still need a base (not-open doc, or an unseeded open doc)
  // OR when the gateway hasn't hydrated this path yet (the write below needs
  // hydration for the BOM + drift baseline).
  if (base === null || !isHydrated(relPath)) {
    try {
      const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return; // swap during the hydrate read
      diskBody = hydrate.body;
      if (base === null) {
        base = hydrate.frontmatter;
        // Seed the cache from disk so a sibling editor sees the disk truth +
        // this leg's edit, and the gateway can source-preserve untouched bytes.
        if (notePath) {
          documentStore.setFrontmatter(notePath, hydrate.frontmatter, hydrate.rawFrontmatter);
        }
      }
    } catch {
      // File missing or unreadable — mark hydrated with no BOM so the write
      // below ENOENT-fails on missing files. Flag the failure so the
      // no-baseline branch refuses (rather than blind-writes) when there's no
      // live editor body to fall back on.
      readFailed = true;
      markHydrated(relPath, false);
    }
  }
  if (base === null) {
    const indexed = vaultIndexStore.getMetadata(relPath)?.frontmatter;
    if (indexed) base = indexed as Record<string, unknown>;
  }

  // Prefer the live in-memory body — an open TextTile/DocumentEditor keeps it
  // current with un-debounced keystrokes — then the disk-read body, then the
  // watcher snapshot so a popup-only edit (no editor mounted) still round-trips.
  const body =
    docState?.body ?? diskBody ?? vaultIndexStore.getMetadata(relPath)?.content ?? '';

  let merged: Record<string, unknown>;
  const conflicts: string[] = [];
  // The safe (non-conflicting) owned keys become an explicit delta the gateway
  // applies to FRESH disk, so any key this command doesn't own survives instead
  // of being reverted off a stale `base`. `merged` is for the DISPLAY cache.
  // `undefined` in the base===null corner keeps a blind-apply write.
  let delta: FrontmatterDelta | undefined;
  if (base === null) {
    // No baseline: the disk read THREW and neither cache nor index held
    // frontmatter (a successful read always yields an object).
    //
    // A non-ENOENT read failure (FILE_TOO_LARGE, transient EACCES/EBUSY) leaves
    // the file PRESENT, so the write would succeed and replace the real note
    // with a stale/empty body. With no live editor body, refuse: markPathFailed
    // (keeps `.filo/.dirty` + "save failed") + reportError + throw, so history
    // rolls the command back.
    if (readFailed && !docState) {
      markPathFailed(vaultRoot, relPath);
      const err = new Error(
        `Could not read ${relPath} to apply properties; refusing to overwrite it with an unverified body.`,
      );
      reportError('updateProperties', err, `Failed to apply properties to ${relPath}`);
      throw err;
    }
    // Otherwise a live editor body IS available (`docState.body`), so the body
    // is safe to write — blind-apply the target snapshot's FM; with nothing
    // else visible there's no external key to lose.
    merged = cleanFrontmatter({ ...targetFm });
  } else {
    merged = { ...base };
    const d: FrontmatterDelta = { set: {}, unset: [] };
    for (const k of ownedKeys) {
      // Conflict: an external edit moved this field away from what this
      // command's opposite leg left it at. Keep the external value, skip.
      if (!fmValueEqual(base[k], otherFm[k])) {
        conflicts.push(k);
        continue;
      }
      const v = targetFm[k];
      if (k in targetFm && v !== '' && v !== null && v !== undefined) {
        merged[k] = v;
        d.set[k] = v;
      } else {
        delete merged[k];
        d.unset.push(k);
      }
    }
    merged = cleanFrontmatter(merged);
    delta = d;
  }

  // Final swap check before the cache mutation + write. The write
  // IPC is main-side gated (a captured-vaultRoot write throws after a swap), but
  // the documentStore.setFrontmatter cache mutation below is not.
  if (!isStillSameVault(identity)) return;

  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      frontmatter: merged,
      body,
      callerId: `update-properties-command:${relPath}`,
      notePath,
      frontmatterDelta: delta,
      // Fire-time body-source decision (`body` above prefers `docState?.body`);
      // the gateway must not re-derive it at write time.
      bodyIsLive: docState != null,
    });
  } catch (err) {
    reportError('updateProperties', err, `Failed to apply properties to ${relPath}`);
    // Rethrow so execute()/undo() reject and history drops the never-applied
    // command instead of leaving it on the stack as "applied".
    throw err;
  }

  // Sync the live FM cache so an open editor/popup sees the applied result
  // (an open PropertiesPopup would otherwise re-write its stale snapshot and
  // clobber it). Stamped only AFTER a successful write, since history rollback
  // doesn't revert cache mutations. Identity-guarded so a swap during the write
  // can't re-create the outgoing doc's entry in the new vault.
  if (notePath && isStillSameVault(identity)) documentStore.setFrontmatter(notePath, merged);

  if (conflicts.length > 0) {
    uiStore.pushToast({
      text: `External edit changed ${conflicts.join(', ')} in ${relPath}. Kept the external value — that field's undo/redo was skipped.`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Apply anyway',
          handler: () => {
            // The `duration: 0` toast can be clicked after a vault swap; bail
            // so the outgoing vault's patch never lands on the new vault's
            // same-named file.
            if (!isStillSameVault(identity)) return;
            // The user insists — force the owned snapshot value onto the
            // conflicting fields, as their own delta so the gateway applies
            // ONLY them to fresh disk (every other key stays).
            const forcedDelta: FrontmatterDelta = { set: {}, unset: [] };
            for (const k of conflicts) {
              const v = targetFm[k];
              if (k in targetFm && v !== '' && v !== null && v !== undefined) {
                forcedDelta.set[k] = v;
              } else {
                forcedDelta.unset.push(k);
              }
            }
            // Re-resolve the body at CLICK time: a conflict-time body would
            // revert every editor save made since. With no live editor,
            // `bodyIsLive: false` makes the gateway source the body from its
            // fresh in-chain disk read.
            const liveDoc = notePath ? documentStore.getDocument(notePath) : null;
            // Display cache — merge the forced keys onto the CURRENT cache,
            // not the conflict-time `merged` object (stale by click time).
            if (notePath) {
              const liveBase = documentStore.getFrontmatter(notePath);
              if (liveBase) {
                const updated: Record<string, unknown> = { ...liveBase };
                for (const k of conflicts) {
                  const v = targetFm[k];
                  if (k in targetFm && v !== '' && v !== null && v !== undefined) {
                    updated[k] = v;
                  } else {
                    delete updated[k];
                  }
                }
                documentStore.setFrontmatter(notePath, cleanFrontmatter(updated));
              }
            }
            void writeMarkdownFile({
              vaultRoot,
              relPath,
              body: liveDoc?.body ?? body,
              callerId: `update-properties-command:${relPath}`,
              notePath,
              frontmatterDelta: forcedDelta,
              // Click-time liveness decision.
              bodyIsLive: liveDoc != null,
            }).catch((err) =>
              reportError('updateProperties', err, `Failed to apply properties to ${relPath}`),
            );
            // allow-non-target-markdirty: module helper, callers pass this.targetBoardId per the CI gate
            boardCacheStore.markDirty(targetBoardId);
          },
        },
      ],
    });
  }
}
