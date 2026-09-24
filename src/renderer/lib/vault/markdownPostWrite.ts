/**
 * The markdown gateway's post-write tail, split out of `markdownFileWriter.ts`
 * (file-size ceiling).
 *
 *  - `confirmPostWriteBaseline` — stat + (size-gated) read-back that stamps the
 *    drift baseline only when disk holds EXACTLY the bytes we wrote, and records
 *    those confirmed bytes on the baseline so a later identical write can skip.
 *  - `finishWriteBookkeeping` — vault-index refresh, FM flushed-version and the
 *    guarded markClean. Shared by a real write AND the identical-bytes skip, so
 *    the markClean guard lives in one place.
 *
 * Plain reads only (no `markHydrated`), so `gates:markdown-read-gateway`'s
 * read+hydrate pairing rule does not apply here.
 */
import { invokeOk } from '../utils/invokeOk';
import { refreshBaselineAfterWrite } from './fileBaselineRegistry';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { parseMarkdown } from './vaultIndex';
import { noteFrontmatterFlushedVersion } from '../boards/frontmatterWriteScheduler';

/**
 * Byte threshold above which the post-write CONTENT read-back is skipped
 * (size-only baseline confirmation instead). A read-back doubles write-path
 * IO, and for a multi-MB note on a slow volume that can push past
 * `MARKDOWN_WRITE_TIMEOUT_MS`. Small notes keep the same-byte-count
 * foreign-write protection; larger ones accept the residual hole
 * (KNOWN_LIMITATIONS #15). Also the cap on the confirmed text a baseline keeps.
 */
export const MARKDOWN_READBACK_BYTE_THRESHOLD = 1_000_000; // 1 MB

/**
 * Refresh the baseline to the post-write mtime so a late watcher echo (or the
 * next debounced write) compares against the state we just wrote. On an
 * unusable post-write stat KEEP the prior baseline: at worst a spurious drift
 * prompt on the next write, instead of disabling the drift check.
 */
export async function confirmPostWriteBaseline(
  vaultRoot: string,
  relPath: string,
  fileText: string,
  writtenByteLength: number,
): Promise<void> {
  try {
    const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
    // TOCTOU guard: a foreign edit can land in the write→stat gap. A size
    // mismatch keeps the prior baseline. A size match isn't sufficient (a
    // same-byte-count foreign write would be adopted and then clobbered), so
    // small notes read the bytes BACK and stamp only on an exact match; notes
    // at/above MARKDOWN_READBACK_BYTE_THRESHOLD accept size-only (KNOWN_LIMITATIONS #15).
    let confirmed = false;
    let readBackMatched = false;
    if (postStat.size === writtenByteLength) {
      if (writtenByteLength < MARKDOWN_READBACK_BYTE_THRESHOLD) {
        try {
          const readBack = await invokeOk('vault:read-file-text', vaultRoot, relPath);
          confirmed = readBack.content === fileText;
          readBackMatched = confirmed;
        } catch {
          /* transient IO — keep prior baseline (safe direction) */
        }
      } else {
        // Large note: size matched our written bytes; accept it (residual
        // same-byte-count-foreign-write hole documented in KNOWN_LIMITATIONS #15).
        confirmed = true;
      }
    }
    if (confirmed) {
      // Record the bytes only when the read-back PROVED them.
      refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size, readBackMatched ? fileText : undefined);
    } else {
      refreshBaselineAfterWrite(relPath, undefined, undefined);
    }
  } catch {
    refreshBaselineAfterWrite(relPath, undefined, undefined);
  }
}

/**
 * Index refresh + FM flushed-version + guarded markClean after a write landed
 * (or was skipped because disk already held these exact bytes).
 */
export function finishWriteBookkeeping(opts: {
  relPath: string;
  fileText: string;
  notePath: string | null | undefined;
  callerId: string;
  mutationVersionAtCapture?: number;
  /** True when a NEWER write for this caller is armed or parked. */
  hasNewerWriteFor: (callerId: string) => boolean;
}): void {
  const { relPath, fileText, notePath, callerId } = opts;
  // Refresh the vault index from the just-written bytes
  // so a late watcher echo past the renderer-side suppression TTL
  // (1.5 s idle / 5 s bulk) classifies as 'ignore' / 'noop-change' instead
  // of comparing the post-write disk content against the stale pre-write
  // baseline (which would surface a spurious "modified externally" toast
  // for the user's own write). Synthesised locally (the bytes are on disk);
  // best-effort — a parse failure doesn't fail the write.
  try {
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, fileText));
  } catch (err) {
    console.warn('[markdownFileWriter] post-write index refresh failed (best-effort):', err);
  }
  if (notePath) {
    // Record the CAPTURED version (what the assembled body/FM
    // correspond to), never the live post-IPC counter, which would mark a
    // mid-IPC mutation as flushed and let its follow-up write skip as stale.
    noteFrontmatterFlushedVersion(notePath, opts.mutationVersionAtCapture ?? 0);
  }
  // A successful write clears THIS writer's dirty entry so a saved editor goes
  // clean (else spurious "modified externally" prompts). Skipped when a newer
  // write is armed or PARKED behind this one: a transient clean window could be
  // misread by an external-edit reconciler into a silent reload of unsaved
  // keystrokes. Deliberately NOT gated on a pending FM write for this path
  // (`conflictResolver` checks `isPathPending`); that would strand this callerId.
  if (notePath && !opts.hasNewerWriteFor(callerId)) {
    documentStore.markClean(notePath, callerId);
  }
}
