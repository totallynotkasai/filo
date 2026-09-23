import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  VaultIndex,
  collectMarkdownPaths,
  countTagsInInlineTiles,
  parseMarkdown,
  type FileMetadata,
} from '../lib/vault/vaultIndex';
import { vaultStore } from './vault.svelte';
import { reportError } from '../lib/utils/errorBus';
import { isMarkdownExtension } from '../lib/vault/extension';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { noteReadEncoding } from '../lib/vault/nonUtf8Paths.svelte';
import { stripLeadingSlash, toPosix } from '../lib/utils/path';
import type { FileTreeNode } from '../../shared/types';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Reactive wrapper around the VaultIndex. Rebuilds the index on vault open,
 * updates it incrementally from file watcher events, and exposes Svelte 5
 * rune-backed getters that components can read from.
 */

const index = new VaultIndex();
let version = $state(0);
let isBuilding = $state(false);

/**
 * 2.2 (#5) — monotonic rebuild generation. A fast A→B vault swap can start a
 * second `rebuild()` while the first is still awaiting its chunked reads; both
 * share this module's `index` / `isBuilding` / `buildCompleteResolvers`.
 * Without a token the OUTGOING rebuild's `finally` flips `isBuilding=false` and
 * drains the INCOMING rebuild's resolvers against a half-built index
 * (re-opening 6.2.H3), and its chunk loop keeps upserting stale-vault entries.
 * Every `rebuild()` captures the counter at entry; a superseded rebuild aborts
 * its chunk loop and skips the `finally` drain so only the live generation owns
 * the shared building state.
 */
let buildGeneration = 0;

/**
 * 6.2.H3 — resolvers waiting for the current `rebuild()` to finish. Drained
 * in `rebuild()`'s `finally` block once `isBuilding` flips back to false.
 * Callers that need to read post-rebuild metadata (the recovery sequencer's
 * tag-rewrite partial-state detection) `await vaultIndexStore.whenBuildComplete()`
 * before sampling `allMetadata()` — without it, the metadata sample could
 * fire mid-chunked-rebuild and miss the very `newName` carrier that proves
 * a partial commit, so the sequencer would offer "Discard plan" against a
 * vault that's actually mid-rename.
 */
const buildCompleteResolvers: Array<() => void> = [];

function bump(): void {
  version += 1;
}

function normaliseRel(relativePath: string): string {
  return stripLeadingSlash(toPosix(relativePath));
}

interface ReadFileResult {
  ok: boolean;
  content: string | null;
  code: string | null;
  // Audit2 4.3 — the disk mtime the IPC captured in its pre-flight stat. The
  // index stamps this (not Date.now()) so the partial-read stability window
  // measures the file's real age, not the moment we happened to read it.
  mtimeMs: number | null;
  /** Audit-19 ERR-7 — 'invalid-utf-8' when the bytes aren't UTF-8 (absent = UTF-8). */
  encoding?: 'utf-8' | 'invalid-utf-8';
}

// Phase 37 / 37.6 — two-arg canonical shape: (vaultRoot, relativePath).
// Legacy single-arg branch in `vault:read-file-text` has been removed,
// so passing a pre-joined absolute path no longer works.
async function readFileText(vaultRoot: string, relativePath: string): Promise<ReadFileResult> {
  const res = await window.filo.invoke('vault:read-file-text', vaultRoot, relativePath);
  if (res.success) {
    return { ok: true, content: res.content, code: null, mtimeMs: res.mtimeMs ?? null, encoding: res.encoding };
  }
  return { ok: false, content: null, code: res.code ?? null, mtimeMs: null };
}

const TRANSIENT_RETRY_MS = 2000;
const pendingRetries = new SvelteMap<string, ReturnType<typeof setTimeout>>();

async function indexOnePath(relativePath: string): Promise<void> {
  const root = vaultStore.path;
  if (!root) return;
  const identity = captureVaultIdentity();
  const rel = normaliseRel(relativePath);
  const res = await readFileText(root, rel);
  // 2.2 (#5) — re-check vault identity AFTER the awaited read. A vault swap (or
  // close) during the read leaves `root` pointing at the PRIOR vault; upserting,
  // removing, or scheduling a retry against the live index now would graft the
  // old vault's file (or a phantom retry timer) onto the new vault's metadata.
  // Audit-11 VS-6 — generation-aware so a close → reopen of the SAME path (same
  // string, new instance) reads as stale too, not just a different-path swap.
  if (!isStillSameVault(identity)) return;
  if (res.ok && res.content !== null) {
    // Audit2 4.3 — stamp the disk mtime, not Date.now(). Date.now() made the
    // partial-read window (now - lastModified < 1s) always true, forcing every
    // settled external truncation through the ~5s retry path.
    const metadata = parseMarkdown(relativePath, res.content, res.mtimeMs ?? Date.now());
    index.upsert(metadata);
    noteReadEncoding(rel, res.encoding); // Audit-19 ERR-7 — a non-UTF-8 note opens non-editable
    // Cancel any pending retry — the read succeeded this pass.
    const pending = pendingRetries.get(relativePath);
    if (pending) {
      clearTimeout(pending);
      pendingRetries.delete(relativePath);
    }
    return;
  }
  // Phase 31 C3.6 — only delete the index entry on a true "missing file"
  // signal. EACCES/EBUSY/EPERM/EMFILE mean we couldn't read RIGHT NOW; the
  // index entry from the prior pass is more accurate than nothing. Schedule
  // a single retry; subsequent watcher events will re-enqueue if still bad.
  const code = res.code ?? 'ENOENT';
  if (code === 'ENOENT') {
    index.remove(relativePath);
    return;
  }
  // Transient — leave the existing index entry in place and retry in 2 s.
  // Single in-flight retry per path to avoid timer pile-up.
  if (pendingRetries.has(relativePath)) return;
  const timer = setTimeout(() => {
    pendingRetries.delete(relativePath);
    void indexOnePath(relativePath);
  }, TRANSIENT_RETRY_MS);
  pendingRetries.set(relativePath, timer);
}

/**
 * Phase 31 C2.2 — chunked parallelism for cold-rebuild + bulk applyChanges.
 *
 * Splits the path list into batches of REBUILD_CHUNK_SIZE and runs
 * `indexOnePath` in parallel within each batch. Batched-sequential keeps the
 * IPC backlog bounded (otherwise opening a 5000-file vault would queue 5000
 * concurrent file-text invokes and starve the main process). 16 is a
 * conservative ceiling that empirically tracks NVMe sequential-read with
 * Electron's IPC scheduler; raise cautiously.
 */
const REBUILD_CHUNK_SIZE = 16;
async function indexPathsChunked(
  paths: string[],
  // 2.2 (#5) — optional staleness probe. `rebuild()` passes its generation
  // check so the loop bails between chunks the instant a newer rebuild (or
  // vault swap) supersedes it, rather than reading every remaining file of a
  // vault that's no longer open. `applyChanges` omits it (incremental updates
  // are not generation-scoped).
  isCurrent?: () => boolean,
): Promise<void> {
  for (let i = 0; i < paths.length; i += REBUILD_CHUNK_SIZE) {
    if (isCurrent && !isCurrent()) return;
    const chunk = paths.slice(i, i + REBUILD_CHUNK_SIZE);
    await Promise.all(chunk.map((rel) => indexOnePath(rel)));
  }
}


export const vaultIndexStore = {
  /** Read-only reactive cursor — any getter that depends on this will refresh. */
  get version() { void version; return version; },
  get isBuilding() { return isBuilding; },

  getMetadata(path: string): FileMetadata | null {
    void version;
    return index.get(path);
  },

  allMetadata(): FileMetadata[] {
    void version;
    return index.allMetadata();
  },

  allTags(): Map<string, number> {
    void version;
    // SvelteMap (rather than plain Map) so this reactive accessor stays on
    // the proxy path Svelte's reactivity prefers — matches the project's
    // svelte/prefer-svelte-reactivity rule.
    const counts = new SvelteMap<string, number>(index.allTags());
    // Frontmatter-only `index.allTags()` misses inline tiles (Link / Iframe /
    // Timer) — they live in board JSON, not in any `.md`. Merge inline-tile
    // contributions so the toolbar tag chips and properties autocomplete
    // surface their counts alongside file-backed tags.
    const project = vaultStore.project as { boards: Array<{ inlineTiles?: Record<string, unknown> }> } | null;
    for (const [tag, n] of countTagsInInlineTiles(project)) {
      counts.set(tag, (counts.get(tag) ?? 0) + n);
    }
    return counts;
  },

  /**
   * Rebuilds the entire index from the current vault tree. Called when the
   * user opens a vault, or after a change that bulk-invalidates the index.
   */
  async rebuild(tree?: FileTreeNode[]): Promise<void> {
    if (!vaultStore.path) {
      index.clear();
      bump();
      return;
    }
    // 2.2 (#5) — claim a generation up-front. `isCurrent()` is false the moment
    // a newer rebuild() (typically the post-vault-swap one) bumps the counter.
    const myGeneration = ++buildGeneration;
    const isCurrent = (): boolean => myGeneration === buildGeneration;
    const capturedRoot = vaultStore.path;
    isBuilding = true;
    try {
      index.clear();
      const source = tree ?? vaultStore.rawTree;
      const paths = collectMarkdownPaths(source, capturedRoot);
      await indexPathsChunked(paths, isCurrent);
    } catch (err) {
      reportError('vaultIndex.rebuild', err, 'Failed to rebuild file index — search and tag lookups may be stale');
    } finally {
      // 2.2 — only the CURRENT generation owns the shared building flag and the
      // resolver drain. A superseded rebuild returns quietly; the newer
      // rebuild's own `finally` flips the flag and drains once IT completes, so
      // `whenBuildComplete()` awaiters see a fully-built index for the LIVE
      // vault rather than this outgoing rebuild's half-built one.
      if (isCurrent()) {
        isBuilding = false;
        bump();
        // 6.2.H3 — drain the build-complete resolvers so any awaiter (the
        // recovery sequencer) sees the post-rebuild metadata. Cleared in one
        // batch so a resolver that re-enqueues itself doesn't loop on a
        // half-drained list.
        const resolvers = buildCompleteResolvers.splice(0);
        for (const r of resolvers) r();
      }
    }
  },

  /**
   * 6.2.H3 — resolves once the current `rebuild()` finishes, or immediately
   * when no rebuild is in flight. The recovery sequencer awaits this before
   * sampling `allMetadata()` for partial-tag-rewrite detection: pre-fix the
   * sequencer raced the rebuild, sampled a mid-chunk empty/partial index,
   * decided "no carrier therefore not partial", and offered a Discard that
   * actually discarded a partially-committed rename.
   */
  whenBuildComplete(): Promise<void> {
    if (!isBuilding) return Promise.resolve();
    return new Promise<void>((resolve) => {
      buildCompleteResolvers.push(resolve);
    });
  },

  /**
   * Applies a batch of file watcher change events. Each event refers to a
   * .md file by vault-relative path; we re-read and re-index that file, or
   * remove it if it no longer exists.
   */
  async applyChanges(relativePaths: string[]): Promise<void> {
    if (!relativePaths.length) return;
    if (!vaultStore.path) return;
    const seen = new SvelteSet<string>();
    const toIndex: string[] = [];
    for (const raw of relativePaths) {
      const rel = toPosix(raw);
      if (seen.has(rel)) continue;
      seen.add(rel);
      // Phase 1 / 1.3 — accept both `.md` and `.markdown` (case-insensitive).
      // The watcher classifier (`fileWatcher.classifyChange`) already emits
      // `document` events for `.markdown`; without this match, those events
      // were silently dropped on the floor and the external-edit pipeline
      // never saw `.markdown` files at all.
      const dot = rel.lastIndexOf('.');
      const ext = dot >= 0 ? rel.slice(dot) : '';
      if (!isMarkdownExtension(ext)) continue;
      toIndex.push(rel);
    }
    await indexPathsChunked(toIndex);
    bump();
  },

  /**
   * Restores a previously-captured metadata snapshot into the index.
   * Phase 31 A4.4 — partial-read-retry hook: when `applyChanges` reads a
   * mid-write truncated file and the classifier flags `partial-read-retry`,
   * the caller restores the prior baseline so the next retry pass compares
   * against the pre-shrink content (preventing classification of the
   * GROWN-back size as another shrink).
   *
   * Bumps `version` so reactive consumers re-render. Pass `null` to drop
   * the entry (mirrors `removePath`).
   */
  restoreMetadata(relativePath: string, metadata: FileMetadata | null): void {
    if (metadata === null) {
      index.remove(relativePath);
    } else {
      index.upsert(metadata);
    }
    bump();
  },

  /**
   * Sprint B / B9 — rebinds an index entry from `oldPath` to `newPath`
   * without re-reading the file. Called from both in-app rename and
   * `handleExternalRename` so vault search returns the new path without
   * waiting for the next full reindex pass. No-ops if `oldPath` is not
   * indexed (the file was never markdown, or hasn't been read yet).
   */
  renameKey(oldPath: string, newPath: string): void {
    index.renameKey(oldPath, newPath);
    bump();
  },

  /** Clears the index entirely (e.g. on vault close). */
  clear(): void {
    index.clear();
    bump();
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops every cached metadata entry and cancels every in-flight transient-
// read retry timer. The actual rebuild against the new vault tree happens
// inside `vault.svelte.ts:openVault` after hydration, because the rebuild
// has a tag-seeding follow-up that depends on `fileTagsStore` being
// hydrated first.
onVaultSwap('pre-swap', 'vaultIndex', () => {
  for (const timer of pendingRetries.values()) clearTimeout(timer);
  pendingRetries.clear();
  index.clear();
  bump();
});
