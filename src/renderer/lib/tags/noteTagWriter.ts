/**
 * Writes one tag add/remove into a note's frontmatter. The note's file is the
 * only copy of its tags, so this is the whole change: a fresh read, the
 * source-preserving rewriter (only the `tags:` entry changes), a write, then
 * a re-index.
 */
import { SvelteSet } from 'svelte/reactivity';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { addTagToMarkdown, removeTagFromMarkdown } from '../vault/tagRewriter';
import { dropStaleSeededFrontmatterCache } from '../vault/staleSeededFrontmatter';
import { markPathFailed } from '../boards/boardSaver';
import { runSerializedMarkdownWrite } from '../vault/markdownFileWriter';
import { refreshBaselineAfterWrite, getBaseline, hasBaselineDrifted } from '../vault/fileBaselineRegistry';
import { writeMarkdownAndReconcile } from '../vault/syncOpenEditorsAfterDiskMutation';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { vaultStore } from '../../stores/vault.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { documentStore } from '../../stores/document.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultSwapResettable } from '../../core/vaultLifecycle';

/**
 * True when the bytes the single-tag fast path just READ had already drifted
 * from the pre-write baseline (an undetected external edit). The stat comes
 * from the same `vault:read-file-text`, so no extra IPC. Gates the post-write
 * `refreshBaselineAfterWrite`: stamping on drift would launder the external
 * edit into the baseline and the open editor's next save would silently revert
 * it. Conservative: no prior baseline → false; read withheld its stat (a write
 * raced the read) → treat as drifted.
 */
function baselineDriftedAtRead(
  relPath: string,
  readMtimeMs: number | undefined,
  readSize: number | undefined,
): boolean {
  const baseline = getBaseline(relPath);
  if (baseline === undefined) return false;
  if (readMtimeMs === undefined || readSize === undefined) return true;
  return hasBaselineDrifted(baseline, { mtimeMs: readMtimeMs, size: readSize });
}

/**
 * Fires the read-only tag toast when the file backing the
 * tag write has an open editor that's currently held read-only by the
 * lossy-round-trip sentinel. Deduped by `readOnlyTagToastShown` so a
 * batch of N tag operations against the same file doesn't push N toasts.
 *
 * Idempotent: re-entering after the toast has been shown does nothing
 * until the read-only flag is cleared (via the editor banner's "Take
 * ownership"). The dedupe Set is keyed by the note's path. A rename leaves
 * the entry behind, which at worst shows the toast once more.
 *
 * Reset on vault swap so a stale entry can't suppress a legitimate toast in
 * the new vault.
 */
const readOnlyTagToastShown = new SvelteSet<VaultPath>();
vaultSwapResettable('fileTags.readOnlyTagToastShown', () => readOnlyTagToastShown.clear());

function surfaceReadOnlyTagToastIfNeeded(relPath: string): void {
  const editorDoc = documentStore.findByFilename(relPath);
  if (!editorDoc) return;
  if (!documentStore.isReadOnly(editorDoc.filename)) {
    // Doc isn't read-only — drop any stale dedupe entry so a future
    // read-only flip surfaces the toast again.
    readOnlyTagToastShown.delete(vaultPath(editorDoc.filename));
    return;
  }
  const key = vaultPath(editorDoc.filename);
  if (readOnlyTagToastShown.has(key)) return;
  readOnlyTagToastShown.add(key);
  uiStore.toast(
    "Tag updated. Body changes were not saved because this file's Markdown isn't safe to round-trip.",
    'warning',
    6000,
  );
}

/**
 * Adds or removes one tag in a note's frontmatter: a fresh read, the
 * source-preserving rewriter (only the `tags:` entry changes), a write, then a
 * re-index. Every view reads the note's tags from the file, so nothing else
 * needs updating.
 */
export async function writeTagChangeToMarkdownPath(
  relPath: string,
  tagName: string,
  operation: 'add' | 'remove',
): Promise<void> {
  // Capture identity before the live-path read so the post-await guards below
  // bail on a vault swap instead of applying this vault's tag-write
  // bookkeeping (markPathFailed / baseline / index) to the new one.
  const identity = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot || !relPath) return;
  try {
    let wrote = false;
    // Run the whole read-modify-write serialised behind any in-flight gateway
    // write to this path. The read happens INSIDE the chain so it observes a
    // prior body write's bytes, and the IPC write can't interleave with a
    // concurrent editor write.
    await runSerializedMarkdownWrite(relPath, async () => {
      let raw: string | null = null;
      // Capture the read's own stat (no extra IPC) so the post-write baseline
      // stamp below can be suppressed on pre-write drift.
      let readMtimeMs: number | undefined;
      let readSize: number | undefined;
      try {
        const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
        raw = readResult.content;
        readMtimeMs = readResult.mtimeMs;
        readSize = readResult.size;
      } catch {
        // Read failed (likely envelope-failure or transient I/O). Falls
        // through to the file-exists check below.
      }
      if (raw === null) {
        // Distinguish "file is gone" (a deletion the user expects) from "file
        // exists but we still couldn't read it" (a real I/O failure). Only the
        // second keeps the sentinel dirty + surfaces a toast, so a delete +
        // queued tag write doesn't resurrect a deleted file's sentinel state.
        const exists = await window.filo.invoke('vault:file-exists', vaultRoot, relPath);
        if (!isStillSameVault(identity)) return; // swap during read/exists
        if (exists) {
          markPathFailed(vaultRoot, relPath);
          reportError(
            'fileTags.writePathFrontmatter',
            null,
            `Could not read ${relPath} to update frontmatter — your tag change is not on disk.`,
          );
        }
        return;
      }
      // Pre-write drift? (gates the post-write baseline stamp; see helper)
      const driftedBeforeWrite = baselineDriftedAtRead(relPath, readMtimeMs, readSize);
      const next = operation === 'add'
        ? addTagToMarkdown(raw, tagName)
        : removeTagFromMarkdown(raw, tagName);
      if (next === raw) return;
      // Coupled write+reconcile (frontmatter-only). Writes the existing .md
      // (write-existing so a delete race surfaces as ENOENT, not a resurrection)
      // AND refreshes any open editor's FM cache for the same path so its next
      // body save keeps the tag. Body-preserving.
      await writeMarkdownAndReconcile({
        vaultRoot,
        path: relPath,
        content: next,
        mode: 'frontmatter',
      });
      // Refresh the gateway's pre-write drift baseline to the bytes we just
      // wrote: this path writes the .md directly (not via the gateway), so
      // without it the next editor write sees the mtime+size change as an
      // external edit. Bail on a vault swap before stamping; keep the prior
      // baseline when disk had drifted before this write, so the open editor's
      // next save re-detects + prompts.
      if (driftedBeforeWrite) {
        if (!isStillSameVault(identity)) return;
        refreshBaselineAfterWrite(relPath, undefined, undefined);
      } else {
        try {
          const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size);
        } catch {
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, undefined, undefined);
        }
      }
      wrote = true;
    });
    if (!wrote) return;
    // A swap during the serialized write must not re-index relPath into the
    // new vault or fire its read-only toast against it.
    if (!isStillSameVault(identity)) return;
    await vaultIndexStore.applyChanges([relPath]);
    // A note seeded into the frontmatter cache without an open editor would
    // keep showing its old tags; drop that cache so it reads the fresh index.
    dropStaleSeededFrontmatterCache(relPath);
    // The tag landed, but if the editor is held read-only (body can't
    // round-trip) its body edits are NOT being written — tell the user.
    surfaceReadOnlyTagToastIfNeeded(relPath);
  } catch (err) {
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`);
  }
}
