/**
 * ReplaceAllCommand — vault-wide find-and-replace, history-tracked.
 *
 * Sprint E.5. Mirrors the two-phase atomic pattern from
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
 * are surfaced via the find/find-all UI but skipped by Replace — the
 * semantics of renaming a tile title also need to consider whether the
 * backing file should rename, and that's a different code path
 * (`renameTitleCommand`). Future iterations can extend ReplaceAll to
 * cover titles once the rename-cascade tests are in place.
 *
 * Undo: restores every file's pre-replace snapshot via
 * `vault:write-existing-file-text`. Snapshots live on the command
 * instance, so dropping the command off the history stack drops the
 * recovery breadcrumb — `hasFileSnapshots()` is exposed so the history
 * truncation toast escalates appropriately (Phase 31 B4.8).
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
import { trackComponentWrite } from '../lib/boards/writeStateTracking';

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
    // top). Compute the frontmatter byte length so we can translate body
    // offsets back into raw-file offsets when we splice the replacement.
    const fmEnd = findFrontmatterEnd(content);

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

/**
 * Locates the byte offset where the YAML frontmatter ends in a raw file.
 * Returns 0 when no frontmatter is present. Used to translate body-relative
 * match offsets (from `FileMetadata.content`) into raw-file offsets for the
 * splice-based replacement.
 *
 * Conservative: only recognises the canonical `---\n…---\n` envelope at the
 * head of the file. Files with leading whitespace or BOM still parse but
 * with `fmEnd` correctly reflecting the BOM/whitespace prefix.
 */
function findFrontmatterEnd(raw: string): number {
  // Strip BOM if present so the regex anchors cleanly.
  let prefix = 0;
  if (raw.charCodeAt(0) === 0xfeff) prefix = 1;
  // Body parsing in `gray-matter` strips frontmatter regardless of whitespace
  // before the leading fence, so accept whitespace before the first `---`.
  const rest = raw.slice(prefix);
  const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  const m = rest.match(FRONTMATTER_RE);
  if (!m) return 0;
  return prefix + m[0].length;
}

export class ReplaceAllCommand extends Command {
  description: string;
  /**
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — vault-wide write, not a
   * board-scoped mutation. The field is set to '' in the constructor so
   * the history dispatcher's truthy guard skips the board-match check
   * (matching the prior optional-field semantics for this specific
   * command).
   */
  readonly targetBoardId: string;
  private readonly vaultRoot: string;
  private readonly plans: FilePlan[];

  constructor(vaultRoot: string, plans: FilePlan[]) {
    super();
    // Phase 2 — vault-wide command; empty string skips the history-store
    // guard (see readonly targetBoardId doc above).
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
    await this.writeAll(this.plans.map((p) => ({ path: p.path, content: p.nextContent })));
    // Refresh the vault index so the search panel's matches re-derive against
    // the new content. Without this, the next "Find" cycle would still see
    // the old offsets until the file watcher fires (which may have already
    // been suppressed by `trackComponentWrite`).
    await vaultIndexStore.applyChanges(this.plans.map((p) => p.path));
  }

  async undo(): Promise<void> {
    await this.writeAll(this.plans.map((p) => ({ path: p.path, content: p.originalContent })));
    await vaultIndexStore.applyChanges(this.plans.map((p) => p.path));
  }

  private async writeAll(items: Array<{ path: string; content: string }>): Promise<void> {
    const failed: string[] = [];
    for (const item of items) {
      try {
        await trackComponentWrite(
          this.vaultRoot,
          item.path,
          () => invokeOk('vault:write-existing-file-text', this.vaultRoot, item.path, item.content), // allow-direct-write: vault-wide Replace All operates on raw markdown text and is atomic with the pre-flight read; routing through the debounced markdown gateway would race the in-flight searches.
          { notifyOnError: false },
        );
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
