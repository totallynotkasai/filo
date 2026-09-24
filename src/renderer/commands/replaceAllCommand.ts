/**
 * ReplaceAllCommand — vault-wide find-and-replace, history-tracked.
 *
 * Mirrors the two-phase atomic pattern from
 * `lib/vault/tagRewriteSweep.ts`:
 *
 *   Phase 1 — Read every candidate `.md` file, compute its rewritten
 *   content, capture the original content snapshot for undo. If ANY read
 *   fails, abort before writing anything.
 *
 *   Phase 2 — Write each file in turn. Per-write failures are reported
 *   via the error bus but already-committed writes stay on disk (we
 *   cannot atomically roll back the filesystem). The error toast names
 *   the failed paths so the user can retry.
 *
 * Scope: replaces body matches only. Title matches (matchKind: 'title')
 * are surfaced via the find/find-all UI but skipped by Replace — a title
 * edit is its own undoable command (`UpdateTitleCommand`).
 *
 * Undo: restores every file's pre-replace snapshot. Snapshots live on the
 * command instance, so dropping the command off the history stack drops the
 * recovery breadcrumb — `hasFileSnapshots()` lets the history truncation
 * toast escalate appropriately.
 */

import { Command } from './Command';
import { historyStore } from '../stores/history.svelte';
import { searchStore } from '../stores/search.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { uiStore } from '../stores/ui.svelte';
import { runVaultSearch, type SearchMatch } from '../lib/search/runSearch';
import { invokeOk } from '../lib/utils/invokeOk';
import { reportError } from '../lib/utils/errorBus';
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { runSerializedMarkdownWrite } from '../lib/vault/markdownFileWriter';
import { splitFrontmatterSource } from '../lib/vault/frontmatterRead';

interface FilePlan {
  /** Vault-relative path of the .md file. */
  path: string;
  /** Original on-disk content snapshot (for undo). */
  originalContent: string;
  /** New content with every body match replaced. */
  nextContent: string;
  /** Number of matches that were replaced in this file. */
  replacementCount: number;
}

/**
 * Builds the per-file rewrite plan from a list of matches and the user's
 * replacement string. Reads each file from disk so we never rewrite a stale
 * vault-index copy (the index is the canonical metadata view, but its
 * `content` field is the parsed BODY, not the raw file text — frontmatter
 * lives outside it).
 *
 * Returns either `{ ok: true, plans }` or `{ ok: false, failedPaths }`.
 * A failed read aborts the plan so no writes happen — atomicity of the
 * pre-flight phase.
 */
async function buildPlans(
  vaultRoot: string,
  matches: SearchMatch[],
  replaceText: string,
): Promise<{ ok: true; plans: FilePlan[] } | { ok: false; failedPaths: string[] }> {
  // Group body matches by file path so we apply all replacements in one
  // pass per file. Title matches are skipped (see file docstring).
  const matchesByFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    if (m.matchKind !== 'body') continue;
    if (!m.filePath) continue;
    const list = matchesByFile.get(m.filePath);
    if (list) list.push(m);
    else matchesByFile.set(m.filePath, [m]);
  }

  const plans: FilePlan[] = [];
  const failedPaths: string[] = [];

  for (const [path, matchesInFile] of matchesByFile) {
    let content: string;
    try {
      const result = await invokeOk('vault:read-file-text', vaultRoot, path);
      content = result.content;
    } catch (err) {
      reportError('replaceAll.read', err, `Could not read ${path}; Replace All aborted.`);
      failedPaths.push(path);
      continue;
    }

    // The match offsets in `SearchMatch.matchStart` / `matchEnd` are
    // computed against the parsed BODY (FileMetadata.content), not the
    // raw file (which also contains the YAML frontmatter block at the
    // top). Translate body offsets back into raw-file offsets by measuring
    // the frontmatter prefix with the SAME splitter the search index used.
    //
    // `FileMetadata.content` is produced by `splitFrontmatterSource`, so the FM
    // length MUST come from that exact splitter — any other fence regex can
    // disagree (e.g. on a trailing-space `--- \n`) and splice at wrong offsets.
    // The body is a suffix of `content`, so its start offset in the raw file is
    // exactly `content.length - body.length`.
    const { body: indexedBody } = splitFrontmatterSource(content);
    const fmEnd = content.length - indexedBody.length;

    // Sort matches by descending start offset so each splice doesn't
    // shift the offsets of later matches.
    const sorted = [...matchesInFile].sort((a, b) => b.matchStart - a.matchStart);
    let next = content;
    let replacementCount = 0;
    for (const m of sorted) {
      const rawStart = fmEnd + m.matchStart;
      const rawEnd = fmEnd + m.matchEnd;
      // Guard: confirm the slice we're about to replace still equals the
      // match text (the on-disk file could have changed since the vault
      // index last refreshed). When it doesn't match, skip this single
      // match rather than the whole file — best-effort.
      if (next.slice(rawStart, rawEnd) !== m.matchText) continue;
      next = next.slice(0, rawStart) + replaceText + next.slice(rawEnd);
      replacementCount++;
    }

    if (replacementCount === 0) continue;
    plans.push({ path, originalContent: content, nextContent: next, replacementCount });
  }

  if (failedPaths.length > 0) {
    return { ok: false, failedPaths };
  }
  return { ok: true, plans };
}

export class ReplaceAllCommand extends Command {
  description: string;
  /**
   * Vault-wide write, not a board-scoped mutation: '' so the history
   * dispatcher's guard skips the board-match check.
   */
  readonly targetBoardId: string;
  private readonly vaultRoot: string;
  private readonly plans: FilePlan[];

  constructor(vaultRoot: string, plans: FilePlan[]) {
    super();
    this.targetBoardId = '';
    this.vaultRoot = vaultRoot;
    // allow-shallow: FilePlan members (path, content strings, replacement
    // count number) are all primitive — the per-entry shallow spread plus
    // outer slice is enough.
    this.plans = plans.map((p) => ({ ...p }));
    const totalCount = plans.reduce((n, p) => n + p.replacementCount, 0);
    this.description = `Replace ${totalCount} occurrence(s) across ${plans.length} file(s)`;
  }

  hasFileSnapshots(): boolean {
    return this.plans.length > 0;
  }

  async execute(): Promise<void> {
    // Re-read each file rather than trusting the build-time snapshot, since
    // on a REDO the disk may have moved. Only write when disk STILL equals the
    // planned `originalContent`; otherwise skip (a blind write would clobber
    // the intervening edit and desync the undo snapshot) and name it in the
    // aggregate toast.
    const items: Array<{ path: string; content: string }> = [];
    const skipped: string[] = [];
    for (const p of this.plans) {
      let diskNow: string | null = null;
      try {
        const read = await invokeOk('vault:read-file-text', this.vaultRoot, p.path);
        diskNow = read.content;
      } catch {
        diskNow = null;
      }
      if (diskNow !== null && diskNow === p.originalContent) {
        items.push({ path: p.path, content: p.nextContent });
      } else {
        skipped.push(p.path);
      }
    }
    // `writeAll` writes AND reconciles each open editor per path.
    if (items.length > 0) {
      await this.writeAll(items);
      // Refresh the vault index so the search panel's matches re-derive against
      // the new content. Without this, the next "Find" cycle would still see
      // the old offsets until the file watcher fires (which may have already
      // been suppressed by `trackComponentWrite`).
      await vaultIndexStore.applyChanges(items.map((i) => i.path));
    }
    if (skipped.length > 0) {
      const sample = skipped.slice(0, 3).join(', ');
      const more = skipped.length > 3 ? `, +${skipped.length - 3} more` : '';
      uiStore.toast(
        `Replace skipped ${skipped.length} file(s) changed since the search (${sample}${more}) to avoid overwriting newer edits.`,
        'warning',
        6000,
      );
    }
  }

  async undo(): Promise<void> {
    // Per-file drift check before reverting (symmetric with execute): if a
    // file's CURRENT disk content no longer equals `nextContent`, it was edited
    // after the replace and a blind revert would clobber that edit. A vanished /
    // unreadable file is also skipped (reverting could resurrect a deleted
    // file). Skipped files are named in one aggregate toast, not N prompts.
    const items: Array<{ path: string; content: string }> = [];
    const skipped: string[] = [];
    for (const p of this.plans) {
      let diskNow: string | null = null;
      try {
        const read = await invokeOk('vault:read-file-text', this.vaultRoot, p.path);
        diskNow = read.content;
      } catch {
        diskNow = null;
      }
      if (diskNow !== null && diskNow === p.nextContent) {
        items.push({ path: p.path, content: p.originalContent });
      } else {
        skipped.push(p.path);
      }
    }
    if (items.length > 0) {
      await this.writeAll(items);
      await vaultIndexStore.applyChanges(items.map((i) => i.path));
    }
    if (skipped.length > 0) {
      const sample = skipped.slice(0, 3).join(', ');
      const more = skipped.length > 3 ? `, +${skipped.length - 3} more` : '';
      uiStore.toast(
        `Undo skipped ${skipped.length} file(s) changed since the replace (${sample}${more}) to avoid overwriting newer edits.`,
        'warning',
        6000,
      );
    }
  }

  private async writeAll(items: Array<{ path: string; content: string }>): Promise<void> {
    const failed: string[] = [];
    for (const item of items) {
      try {
        // Coupled write+reconcile. `mode: 'full'` reloads any open editor on
        // this path (its in-memory body would otherwise re-clobber the replace
        // on the next debounce). `notifyOnError: false` avoids a toast per
        // file — the aggregate toast below names the failures. The debounced
        // markdown gateway is deliberately bypassed.
        //
        // Still enrol on the per-path write chain so this write serialises
        // behind an already-in-flight editor write to the same `.md` (which the
        // reconcile's cancel can't reach). It's ordering-only, no debounce.
        await runSerializedMarkdownWrite(item.path, async () => {
          await writeMarkdownAndReconcile({
            vaultRoot: this.vaultRoot,
            path: item.path,
            content: item.content,
            mode: 'full',
            track: { notifyOnError: false },
          });
        });
      } catch (err) {
        reportError('replaceAll.write', err, `Failed to write ${item.path}`);
        failed.push(item.path);
      }
    }
    if (failed.length > 0) {
      const sample = failed.slice(0, 3).join(', ');
      const more = failed.length > 3 ? `, +${failed.length - 3} more` : '';
      uiStore.toast(
        `${failed.length} file(s) failed to write (${sample}${more}). Vault may be in an inconsistent state.`,
        'error',
        6000,
      );
    }
  }
}

/**
 * Builds and runs a Replace All across every body match in the active
 * search query. Routed through `historyStore.execute` so Ctrl+Z restores
 * every file. Returns after the writes settle.
 */
export async function runReplaceAllCommand(): Promise<void> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) {
    uiStore.toast('No vault open.', 'error', 2500);
    return;
  }

  const replaceText = searchStore.replaceText;
  const matches = searchStore.matches;
  if (matches.length === 0) {
    uiStore.toast('No matches to replace.', 'info', 2500);
    return;
  }

  const result = await buildPlans(vaultRoot, matches, replaceText);
  if (!result.ok) {
    const sample = result.failedPaths.slice(0, 3).join(', ');
    uiStore.toast(
      `Replace All aborted — could not read ${result.failedPaths.length} file(s) (${sample}). No changes made.`,
      'error',
      6000,
    );
    return;
  }

  if (result.plans.length === 0) {
    uiStore.toast(
      'No body matches eligible for replacement (title-only matches are skipped).',
      'info',
      3000,
    );
    return;
  }

  const command = new ReplaceAllCommand(vaultRoot, result.plans);
  await historyStore.execute(command);

  const fileCount = result.plans.length;
  const total = result.plans.reduce((n, p) => n + p.replacementCount, 0);
  uiStore.toast(
    `Replaced ${total} occurrence(s) across ${fileCount} file(s). Ctrl+Z to undo.`,
    'success',
    4000,
  );
}

/**
 * Replaces just the current match (the one pointed at by
 * `searchStore.currentMatch`). Single-file write but still routed through
 * `historyStore` so undo restores the prior file content. Returns true on
 * success so the caller can advance the cursor on Find.
 */
export async function replaceCurrentMatch(): Promise<boolean> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) {
    uiStore.toast('No vault open.', 'error', 2500);
    return false;
  }
  const match = searchStore.currentMatch;
  if (!match) return false;
  if (match.matchKind !== 'body') {
    uiStore.toast(
      'Title matches are not replaceable from this panel — open the tile to rename.',
      'info',
      3500,
    );
    return false;
  }
  if (!match.filePath) return false;

  // Re-run the same plan builder against a single match so the splice
  // arithmetic stays in one place. Refresh the result against the latest
  // store state (so a vault edit between Find and Replace doesn't write a
  // stale offset).
  const fresh = runVaultSearch(searchStore.parsed);
  const current = fresh.matches[searchStore.currentIndex];
  if (!current || current.filePath !== match.filePath || current.matchStart !== match.matchStart) {
    uiStore.toast(
      'Match moved or was edited externally — re-run Find before replacing.',
      'warning',
      3500,
    );
    return false;
  }

  const result = await buildPlans(vaultRoot, [current], searchStore.replaceText);
  if (!result.ok) {
    uiStore.toast(`Could not read ${current.filePath}. Replace aborted.`, 'error', 4000);
    return false;
  }
  if (result.plans.length === 0) return false;

  const command = new ReplaceAllCommand(vaultRoot, result.plans);
  await historyStore.execute(command);
  return true;
}
