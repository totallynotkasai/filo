/**
 * ReplaceAllCommand — vault-wide find-and-replace, history-tracked.
 *
 * Mirrors the two-phase atomic pattern from
 * `lib/vault/tagRewriteSweep.ts`:
 *
 *   Phase 1 — Read every candidate `.md` file and work out its replacements
 *   (where each match starts, its text and the replacement). If ANY read
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
 * Undo: puts each match's original text back. The command keeps only the
 * replacements and a hash of the file before and after, never a copy of the
 * note: a file is rewritten only while its bytes are exactly what the command
 * left (or found), so an edit made in between is never overwritten.
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
import { isMissingFileError, NoteBusyError } from '../lib/notes/noteWriter';
import { splitFrontmatterSource } from '../lib/vault/frontmatterRead';
import { noteTextHash } from '../lib/notes/noteFile';

/** One replacement: at `start` (in the file before the replace), `before` became `after`. */
export interface Splice {
  start: number;
  before: string;
  after: string;
}

export interface FilePlan {
  /** Vault-relative path of the .md file. */
  path: string;
  /** The file's bytes before and after the replace, as length + hash. */
  beforeHash: string;
  beforeLength: number;
  afterHash: string;
  afterLength: number;
  /** The replacements, in ascending `start` order. */
  splices: Splice[];
}

/**
 * The file's text with `plan`'s replacements applied (`forward`) or taken
 * back, when `text` is exactly the text the plan starts from in that
 * direction; otherwise null.
 */
export function applyPlan(text: string, plan: FilePlan, forward: boolean): string | null {
  const expectLength = forward ? plan.beforeLength : plan.afterLength;
  const expectHash = forward ? plan.beforeHash : plan.afterHash;
  if (text.length !== expectLength || noteTextHash(text) !== expectHash) return null;
  // Offsets are into the pre-replace text; going backward, shift each by the
  // growth of the replacements before it.
  let shift = 0;
  const positioned = plan.splices.map((s) => {
    const at = forward ? s.start : s.start + shift;
    shift += s.after.length - s.before.length;
    return { at, from: forward ? s.before : s.after, to: forward ? s.after : s.before };
  });
  let out = text;
  for (let i = positioned.length - 1; i >= 0; i--) {
    const p = positioned[i]!;
    if (out.slice(p.at, p.at + p.from.length) !== p.from) return null;
    out = out.slice(0, p.at) + p.to + out.slice(p.at + p.from.length);
  }
  return out;
}

/** A plan for turning `content` into the result of `splices` (ascending, non-overlapping). */
export function planFor(path: string, content: string, splices: Splice[]): FilePlan {
  let next = content;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i]!;
    next = next.slice(0, s.start) + s.after + next.slice(s.start + s.before.length);
  }
  return {
    path,
    beforeHash: noteTextHash(content),
    beforeLength: content.length,
    afterHash: noteTextHash(next),
    afterLength: next.length,
    splices: splices.map((s) => ({ ...s })),
  };
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

    const splices: Splice[] = [];
    let lastEnd = -1;
    for (const m of [...matchesInFile].sort((a, b) => a.matchStart - b.matchStart)) {
      const rawStart = fmEnd + m.matchStart;
      const rawEnd = fmEnd + m.matchEnd;
      // Guard: the slice must still equal the match text (the file could
      // have changed since the vault index last refreshed), and matches
      // never overlap. A stale match is skipped, not the whole file.
      if (rawStart < lastEnd || content.slice(rawStart, rawEnd) !== m.matchText) continue;
      splices.push({ start: rawStart, before: m.matchText, after: replaceText });
      lastEnd = rawEnd;
    }

    if (splices.length === 0) continue;
    plans.push(planFor(path, content, splices));
  }

  if (failedPaths.length > 0) {
    return { ok: false, failedPaths };
  }
  return { ok: true, plans };
}

// allow-own-board-only: rewrites notes only; it holds no board snapshot
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
    this.plans = this.snapshot(plans);
    const totalCount = plans.reduce((n, p) => n + p.splices.length, 0);
    this.description = `Replace ${totalCount} occurrence(s) across ${plans.length} file(s)`;
  }

  async execute(): Promise<void> {
    // On a redo the disk may have moved: a file is rewritten only while it
    // still holds exactly what the search found; otherwise it is skipped (a
    // blind write would clobber the intervening edit) and named in the
    // aggregate toast.
    const skipped = await this.swapAll(true);
    this.toastSkipped(skipped, 'Replace skipped', 'changed since the search');
  }

  async undo(): Promise<void> {
    // Symmetric: a file edited after the replace (or gone) is left alone.
    const skipped = await this.swapAll(false);
    this.toastSkipped(skipped, 'Undo skipped', 'changed since the replace');
  }

  /**
   * Applies (or takes back) every plan through the note store: inside each
   * note's write queue, after anything queued for it (an editor body) has
   * landed, and only when the fresh bytes are exactly what the plan expects.
   * Any open view of the note follows. Returns the files that didn't match.
   */
  private async swapAll(forward: boolean): Promise<string[]> {
    const skipped: string[] = [];
    const busy: string[] = [];
    const failed: string[] = [];
    for (const plan of this.plans) {
      let matched = false;
      try {
        await noteStore.transform(
          plan.path,
          (fresh) => {
            const next = applyPlan(fresh.raw, plan, forward);
            if (next === null) return null;
            matched = true;
            return next;
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
        if (err instanceof NoteBusyError) {
          busy.push(plan.path);
          continue;
        }
        reportError('replaceAll.write', err, `Failed to write ${plan.path}`);
        failed.push(plan.path);
      }
    }
    if (busy.length > 0) {
      const sample = busy.slice(0, 3).join(', ');
      const more = busy.length > 3 ? `, +${busy.length - 3} more` : '';
      uiStore.toast(
        `Left ${busy.length} file(s) alone because an edit to them isn't saved yet (${sample}${more}). Save or resolve it, then run Replace All again.`,
        'warning',
        8000,
      );
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
  const total = result.plans.reduce((n, p) => n + p.splices.length, 0);
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
