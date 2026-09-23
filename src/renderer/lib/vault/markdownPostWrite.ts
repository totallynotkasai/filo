/**
 * Audit-19 MD-2 — the markdown gateway's post-write tail, extracted from
 * `markdownFileWriter.ts` (which sat exactly at its file-size ceiling) so the
 * identical-bytes skip could be added with the gateway net-SHRINKING.
 *
 *  - `confirmPostWriteBaseline` — stat + (size-gated) read-back that stamps the
 *    drift baseline only when disk holds EXACTLY the bytes we wrote, and records
 *    those confirmed bytes on the baseline so a later identical write can skip.
 *  - `finishWriteBookkeeping` — vault-index refresh, FM flushed-version and the
 *    guarded markClean. Shared by a real write AND the identical-bytes skip, so
 *    the markClean guard lives in one place.
 *
 * Plain reads only (no `markHydrated`), so `ci:markdown-read-gateway`'s
 * read+hydrate pairing rule does not apply here.
 */
import { invokeOk } from '../utils/invokeOk';
import { refreshBaselineAfterWrite } from './fileBaselineRegistry';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { parseMarkdown } from './vaultIndex';
import { noteFrontmatterFlushedVersion } from '../boards/frontmatterWriteScheduler';

/**
 * Audit-18 5.4 — byte threshold above which the Audit-17 5.3 post-write CONTENT
 * read-back is skipped (size-only baseline confirmation instead). A markdown
 * write is 300 ms idle-debounced and bound by `MARKDOWN_WRITE_TIMEOUT_MS`
 * (60 s); a full content read-back on EVERY write doubles write-path IO, and for
 * a multi-MB note on a slow volume (OneDrive/SMB/AV) that can push past the
 * timeout into timeout-then-self-heal flapping. Small notes (the overwhelming
 * majority) keep the read-back's same-byte-count-foreign-write protection; notes
 * at or above the threshold fall back to size-only (the residual hole is
 * documented in KNOWN_LIMITATIONS #15, mirroring the board scheduler's whole-file
 * decision in #14). Exported so the behavioural matrix can pin the boundary.
 * Audit-19 MD-2 — also the cap on the confirmed text a baseline keeps.
 */
export const MARKDOWN_READBACK_BYTE_THRESHOLD = 1_000_000; // 1 MB

/**
 * Phase R6 — refresh the baseline to the post-write mtime so a late watcher echo
 * (or the next debounced write) compares against the state we just wrote.
 * Audit-4 DI-14 — on an unusable post-write stat KEEP the prior baseline
 * (reverting 6.4.M2's clear): a stat failure then surfaces at worst a spurious
 * drift prompt on the NEXT write instead of disabling the drift check and
 * opening a silent-overwrite window.
 */
export async function confirmPostWriteBaseline(
  vaultRoot: string,
  relPath: string,
  fileText: string,
  writtenByteLength: number,
): Promise<void> {
  try {
    const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
    // Audit-7 L5 — TOCTOU guard. A foreign edit can land in the write→stat gap.
    // Size fast-path rejects the easy mismatch (keep prior baseline, DI-14).
    // Audit-17 5.3 — size match is necessary but NOT sufficient (a same-byte-count
    // foreign write would be adopted as our baseline → next write clobbers it
    // promptless), so read the bytes BACK and stamp only when disk holds EXACTLY
    // what we wrote; on any content mismatch / unreadable read-back keep the prior
    // baseline so the drift gate re-detects + prompts next write.
    // Audit-18 5.4 — size-gate the read-back: only small notes pay the second
    // read. Notes at/above MARKDOWN_READBACK_BYTE_THRESHOLD accept size-only
    // confirmation to avoid doubling IO on slow volumes (KNOWN_LIMITATIONS #15).
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
      // Audit-19 MD-2 — record the bytes only when the read-back PROVED them.
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
  docId: string | null | undefined;
  callerId: string;
  mutationVersionAtCapture?: number;
  /** True when a NEWER write for this caller is armed or parked. */
  hasNewerWriteFor: (callerId: string) => boolean;
}): void {
  const { relPath, fileText, docId, callerId } = opts;
  // Sprint C / C-A5-2 — refresh the vault index from the just-written bytes
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
  if (docId) {
    // Audit-16 4.3 — record the CAPTURED version (what the assembled body/FM
    // correspond to), never the live post-IPC counter, which would mark a
    // mid-IPC mutation as flushed and let its follow-up write skip as stale.
    noteFrontmatterFlushedVersion(docId, opts.mutationVersionAtCapture ?? 0);
  }
  // Audit-7 M1 — a successful write clears THIS writer's dirty entry so a
  // normally-saved editor goes clean (else `isDirty` stayed pinned → a spurious
  // "modified externally" prompt and a frozen sibling reload `$effect`). Guarded:
  // if the user typed again mid-write a newer timer is armed — or (Audit-17 5.5)
  // a newer fire is PARKED behind this write — so leave it dirty rather than
  // flash a transient clean window an external-edit reconciler could misread
  // into a silent reload of the unsaved keystrokes.
  // Audit-11 WC-2 — deliberately NOT also gated on a pending FM write for this
  // path: the save indicator reads the write LEDGER and `conflictResolver` is
  // guarded by F4 `isPathPending`; gating here would STRAND this body callerId.
  if (docId && !opts.hasNewerWriteFor(callerId)) {
    documentStore.markClean(docId, callerId);
  }
}
