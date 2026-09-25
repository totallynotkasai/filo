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
import { uiStore } from '../stores/ui.svelte';
import { runVaultSearch, type SearchMatch } from '../lib/search/runSearch';
import { invokeOk } from '../lib/utils/invokeOk';
import { reportError } from '../lib/utils/errorBus';
import { noteStore } from '../stores/notes.svelte';
import { isMissingFileError } from '../lib/notes/noteWriter';
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
    // On a redo the disk may have moved: a file is rewritten only while it
    // still holds exactly the planned `originalContent`; otherwise it is
    // skipped (a blind write would clobber the intervening edit and desync the
    // undo snapshot) and named in the aggregate toast.
    const skipped = await this.swapAll('originalContent', 'nextContent');
    this.toastSkipped(skipped, 'Replace skipped', 'changed since the search');
  }

  async undo(): Promise<void> {
    // Symmetric: a file edited after the replace (or gone) is left alone.
    const skipped = await this.swapAll('nextContent', 'originalContent');
    this.toastSkipped(skipped, 'Undo skipped', 'changed since the replace');
  }

  /**
   * Rewrites every planned file from `from` to `to` through the note store:
   * inside each note's write queue, after anything queued for it (an editor
   * body) has landed, and only when the fresh bytes still equal `from`. Any
   * open view of the note follows. Returns the files that didn't match.
   */
  private async swapAll(
    from: 'originalContent' | 'nextContent',
    to: 'originalContent' | 'nextContent',
  ): Promise<string[]> {
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const plan of this.plans) {
      let matched = false;
      try {
        await noteStore.transform(
          plan.path,
          (fresh) => {
            if (fresh.raw !== plan[from]) return null;
            matched = true;
            return plan[to];
          },
          // One aggregate toast below, not one per file.
          { notifyOnError: false },
        );
        if (!matched) skipped.push(plan.path);
      } catch (err) {
        if (isMissingFileError(err)) {
          skipped.push(plan.path);
          continue;
        }
        reportError('replaceAll.write', err, `Failed to write ${plan.path}`);
        failed.push(plan.path);
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
    return skipped;
  }

  private toastSkipped(skipped: string[], verb: string, why: string): void {
    if (skipped.length === 0) return;
    const sample = skipped.slice(0, 3).join(', ');
    const more = skipped.length > 3 ? `, +${skipped.length - 3} more` : '';
    uiStore.toast(
      `${verb} ${skipped.length} file(s) ${why} (${sample}${more}) to avoid overwriting newer edits.`,
      'warning',
      6000,
    );
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
