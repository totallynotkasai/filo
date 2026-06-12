/**
 * Phase 5 / 5.1 — undoable PropertiesPopup edits.
 *
 * Each time the popup closes after the user touched a row, a single
 * `UpdatePropertiesCommand` is pushed for the whole session. Per-keystroke
 * commands would blow through MAX_HISTORY for a normal edit, and the user's
 * mental model is "I opened properties, I undo to close it" — one command
 * per popup-session matches that.
 *
 * Snapshots capture the metadata source for the tile's type:
 *  - text tiles → frontmatter (canonical source, lives on disk)
 *  - non-text tiles → `tile.metadata` (lives in board JSON)
 *
 * Execute / undo apply the corresponding "after" / "before" snapshot. For
 * text tiles the disk write goes through `vault:write-existing-file-text`
 * (same channel the popup itself uses) so an externally-deleted file does
 * not get resurrected by undo. Pending frontmatter writes are drained
 * pre-execute to mirror `UpdateCardFieldCommand` — a rapid Apply → Undo
 * without the flush would race the still-debounced forward write against
 * the inverse patch's fresh write at the same docId.
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
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from '../stores/ui.svelte';
import { fmValueEqual } from './frontmatterRebase';
import { type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';

export type PropertiesSnapshot =
  | { kind: 'frontmatter'; relPath: string; docId: string | null; fm: Record<string, unknown> }
  | { kind: 'metadata'; tileId: string; metadata: Record<string, unknown> };

export class UpdatePropertiesCommand extends Command {
  description: string;
  /**
   * Phase 3 / 3.1 (polish plan 2026-05-25) — capture the originating board
   * so the history dispatcher refuses to redo this against a different
   * board. The execute/undo's `boardCacheStore.markDirty(this.targetBoardId)`
   * call (post Phase 6.1.R3) always uses the captured id — a redo against
   * a different active board would otherwise mark the wrong board dirty
   * AND the targetBoardId guard in `historyStore.undo/redo` surfaces a
   * "switch back to originate" toast.
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
        docId: snap.docId,
        // Phase R3 — `this.snapshot(...)` detaches every nested key/value
        // in the frontmatter map.
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
    // Audit-6 H2 — pass BOTH legs so the frontmatter apply can rebase: it
    // diffs after-vs-before to learn which keys this command OWNS, then merges
    // only those onto the LIVE frontmatter. Any key it doesn't own (incl. one
    // added externally between the popup edit and Ctrl+Z) is preserved.
    await applySnapshot(this.after, this.before, this.targetBoardId);
    // Phase 6.1.R3 — dirty the ORIGINATING board, not whichever board is
    // active at execute/redo time. The metadata-kind branch of
    // `applySnapshot` previously skipped this entirely (silently),
    // leaving the cache flush dependent on a sibling write — this call
    // closes that gap too.
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
 *   - Audit2 4.2 conflict handling: if an external edit moved an owned field
 *     away from what the opposite leg left it at, KEEP the external value and
 *     surface an "Apply anyway" toast (no silent clobber).
 *
 * Pre-fix this `setFrontmatter`-replaced the whole snapshot and wrote it
 * wholesale, so undo erased any externally-added key (H2). The card/task field
 * commands already rebased via `applyFrontmatterPatchRebased`; Properties was
 * the Audit2-4.2 gap.
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

  // FILO-UR-2 (Audit-11) — capture vault identity before the drain so the guards
  // below bail on a swap. The different-path swap is main-side blocked by
  // assertActiveVault; this closes the close→reopen-same-path window (new
  // generation, same path string) + the stale post-write renderer bookkeeping.
  const identity = captureVaultIdentity();

  // Drain pending debounced writes before this command writes its own copy
  // so the prior in-memory state lands on disk first. Same reason as
  // UpdateCardFieldCommand: a rapid Apply → Undo without the flush would
  // race the still-debounced forward write against this command's fresh
  // write at the same path.
  await flushAllPendingFrontmatterWrites();

  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  if (!isStillSameVault(identity)) return; // FILO-UR-2 — swap during the drain

  const { relPath, docId } = target;
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
  // Phase 2 / 2.2 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — only an OPEN
  // editor's documentStore FM cache is a trustworthy rebase base: the
  // sync-frontmatter reconciler keeps it fresh and it carries any unsaved popup
  // FM edits. A NOT-open doc (a Kanban card / Task row seeded once but never
  // opened) is NOT refreshed by that reconciler, so an externally-added key
  // never reached its cache; rebasing this undo/redo onto the stale cache would
  // silently revert that external key (Finding #5). For the not-open case
  // re-read FRESH disk instead — the command already drained pending writes
  // above and is per-path serialized, so the read is race-free. (Interim form
  // of Phase 4's delta-onto-fresh-disk invariant; the index is the last resort.)
  const docState = docId ? documentStore.getDocument(docId) : null;
  let base: Record<string, unknown> | null =
    docState && docId ? documentStore.getFrontmatter(docId) ?? null : null;
  let diskBody: string | undefined;
  // Read disk when we still need a base (not-open doc, or an unseeded open doc)
  // OR when the gateway hasn't hydrated this path yet (the write below needs
  // hydration for the BOM + drift baseline).
  if (base === null || !isHydrated(relPath)) {
    try {
      const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return; // FILO-UR-2 — swap during the hydrate read
      diskBody = hydrate.body;
      if (base === null) {
        base = hydrate.frontmatter;
        // Seed the cache from disk so a sibling editor sees the disk truth +
        // this leg's edit, and the gateway can source-preserve untouched bytes.
        if (docId) {
          documentStore.setFrontmatter(docId, hydrate.frontmatter, hydrate.rawFrontmatter);
        }
      }
    } catch {
      // File missing or unreadable — mark hydrated with no BOM so the write
      // below ENOENT-fails on missing files, surfacing the same toast path
      // the old direct write produced.
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
  // Phase 4 — the safe (non-conflicting) owned keys also become an explicit
  // delta the gateway applies to FRESH disk, so any key this command doesn't own
  // — including one added externally between the popup edit and Ctrl+Z — survives
  // by construction instead of being reverted off a stale `base`. `merged` is
  // still computed for the DISPLAY cache. `undefined` for the base===null corner
  // keeps the legacy blind-apply write (the gateway delta read would just
  // ENOENT-fail on the same unreadable file).
  let delta: FrontmatterDelta | undefined;
  if (base === null) {
    // No baseline obtainable (file unreadable AND nothing cached/indexed) — we
    // can't see any external keys to preserve, so blind-apply the target
    // snapshot. This is the legacy behaviour for that corner; with nothing
    // visible there's no external key to lose.
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

  // FILO-UR-2 — final swap check before the cache mutation + write. The write
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
      docId,
      frontmatterDelta: delta,
      // Audit-16 6.8 — fire-time body-source decision (`body` above prefers
      // `docState?.body`); the gateway must not re-derive it at write time.
      bodyIsLive: docState != null,
    });
  } catch (err) {
    reportError('updateProperties', err, `Failed to apply properties to ${relPath}`);
    // A17-1.4 — rethrow so execute()/undo() reject and historyStore's
    // rollbackExecute/rollbackUndo drop the never-applied command from the
    // stack. The old swallow resolved failure as success: the command sat on
    // the stack as "applied" while disk never changed.
    throw err;
  }

  // Sync the live FM cache so an open editor/popup sees the applied result
  // (an already-open PropertiesPopup would otherwise re-write its stale
  // snapshot 300ms later and clobber what we just applied). A17-1.4 — stamped
  // AFTER the successful write: the history rollback doesn't revert cache
  // mutations, so a pre-write stamp left the display cache diverged from disk
  // when the write failed. Identity-guarded — a swap completing during the
  // write IPC must not re-create the outgoing doc's entry in the new vault.
  if (docId && isStillSameVault(identity)) documentStore.setFrontmatter(docId, merged);

  if (conflicts.length > 0) {
    uiStore.pushToast({
      text: `External edit changed ${conflicts.join(', ')} in ${relPath}. Kept the external value — that field's undo/redo was skipped.`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Apply anyway',
          handler: () => {
            // A17-1.3 class — the `duration: 0` toast can be clicked after a
            // vault swap; bail so the outgoing vault's patch never lands on
            // the new vault's same-named file (the different-path swap is
            // main-side rejected, but a close→reopen of the SAME path passes).
            if (!isStillSameVault(identity)) return;
            // The user insists — force the owned snapshot value onto the
            // conflicting fields too, still preserving untouched (external) keys.
            // Phase 4 — the forced fields become their own delta so the gateway
            // applies ONLY them to fresh disk (every other key, incl. external
            // additions, stays).
            const forcedDelta: FrontmatterDelta = { set: {}, unset: [] };
            for (const k of conflicts) {
              const v = targetFm[k];
              if (k in targetFm && v !== '' && v !== null && v !== undefined) {
                forcedDelta.set[k] = v;
              } else {
                forcedDelta.unset.push(k);
              }
            }
            // A17-1.2 — re-resolve the body at CLICK time. The old handler
            // froze `body`/`bodyIsLive` at CONFLICT time, so a click minutes
            // later wrote the frozen body back — reverting every editor save
            // made in the interim (and a doc CLOSED since the conflict still
            // claimed its frozen body was live). With no live editor,
            // `bodyIsLive: false` makes the gateway's delta branch source the
            // body from its fresh in-chain disk read instead of the snapshot.
            const liveDoc = docId ? documentStore.getDocument(docId) : null;
            // Display cache — merge the forced keys onto the CURRENT cache,
            // not the conflict-time `merged` object (stale by click time).
            if (docId) {
              const liveBase = documentStore.getFrontmatter(docId);
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
                documentStore.setFrontmatter(docId, cleanFrontmatter(updated));
              }
            }
            void writeMarkdownFile({
              vaultRoot,
              relPath,
              body: liveDoc?.body ?? body,
              callerId: `update-properties-command:${relPath}`,
              docId,
              frontmatterDelta: forcedDelta,
              // Audit-16 6.8 / A17-1.2 — click-time liveness decision.
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
