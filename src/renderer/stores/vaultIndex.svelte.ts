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
import { noteReadEncoding, noteReadLink } from '../lib/vault/nonUtf8Paths.svelte';
import { hasHiddenSegment, stripLeadingSlash, toPosix } from '../lib/utils/path';
import type { FileTreeNode } from '../../shared/types';
import { onVaultSwap } from '../core/vaultLifecycle';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';

/**
 * Reactive wrapper around the VaultIndex. Rebuilds the index on vault open,
 * updates it incrementally from file watcher events, and exposes Svelte 5
 * rune-backed getters that components can read from.
 */

const index = new VaultIndex();
let version = $state(0);
let isBuilding = $state(false);

/**
 * Monotonic rebuild generation. A fast A→B vault swap can start a second
 * `rebuild()` while the first is still reading; both share `index` /
 * `isBuilding` / `buildCompleteResolvers`. Without a token the outgoing
 * rebuild's `finally` would drain the incoming rebuild's resolvers against a
 * half-built index. A superseded rebuild aborts its chunk loop and skips the
 * `finally` drain, so only the live generation owns the building state.
 */
let buildGeneration = 0;

/**
 * Resolvers waiting for the current `rebuild()` to finish, drained in its
 * `finally`. See `whenBuildComplete()`.
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
  // The disk mtime the IPC captured in its pre-flight stat. The index stamps
  // this (not Date.now()) so the partial-read stability window measures the
  // file's real age, not the moment we happened to read it.
  mtimeMs: number | null;
  /** 'invalid-utf-8' when the bytes aren't UTF-8 (absent = UTF-8). */
  encoding?: 'utf-8' | 'invalid-utf-8';
  /** True when the path is a symbolic link (the note opens read-only). */
  link?: boolean;
}

async function readFileText(vaultRoot: string, relativePath: string): Promise<ReadFileResult> {
  const res = await window.filo.invoke('vault:read-file-text', vaultRoot, relativePath);
  if (res.success) {
    return {
      ok: true,
      content: res.content,
      code: null,
      mtimeMs: res.mtimeMs ?? null,
      encoding: res.encoding,
      link: res.link === true,
    };
  }
  return { ok: false, content: null, code: res.code ?? null, mtimeMs: null };
}

const TRANSIENT_RETRY_MS = 2000;
const pendingRetries = new SvelteMap<string, ReturnType<typeof setTimeout>>();

/**
 * Per path, bumped by every change to its entry. A read that started before
 * a newer entry landed (Filo's own write stores its bytes straight away, and
 * its watcher echo is hidden) must not put the older bytes back.
 */
// allow-module-state: cleared by the vaultIndex pre-swap handler
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const entrySeq = new Map<VaultPath, number>();
const READS_PER_PATH = 3;

function bumpEntry(relativePath: string): void {
  const key = vaultPath(relativePath);
  entrySeq.set(key, (entrySeq.get(key) ?? 0) + 1);
}

async function indexOnePath(relativePath: string): Promise<void> {
  const root = vaultStore.path;
  if (!root) return;
  const identity = captureVaultIdentity();
  const rel = normaliseRel(relativePath);
  const key = vaultPath(rel);
  let res: ReadFileResult;
  for (let read = 1; ; read++) {
    const seq = entrySeq.get(key) ?? 0;
    res = await readFileText(root, rel);
    if (!isStillSameVault(identity)) break;
    if ((entrySeq.get(key) ?? 0) === seq) break;
    // The entry changed during the read: read again, or leave the newer entry.
    if (read >= READS_PER_PATH) return;
  }
  // Re-check vault identity after the read: a swap (or close → reopen of the
  // same path) during it would graft the old vault's file (or a phantom retry
  // timer) onto the new vault's metadata.
  if (!isStillSameVault(identity)) return;
  if (res.ok && res.content !== null) {
    // Stamp the disk mtime, not Date.now(): Date.now() would make the
    // partial-read window always true, forcing every settled external
    // truncation through the retry path.
    const metadata = parseMarkdown(relativePath, res.content, res.mtimeMs ?? Date.now());
    index.upsert(metadata);
    bumpEntry(rel);
    noteReadEncoding(rel, res.encoding); // a non-UTF-8 note opens non-editable
    noteReadLink(rel, res.link); // so does a symbolic link
    // Cancel any pending retry — the read succeeded this pass.
    const pending = pendingRetries.get(relativePath);
    if (pending) {
      clearTimeout(pending);
      pendingRetries.delete(relativePath);
    }
    return;
  }
  // Only delete the index entry on a true "missing file" signal. EACCES/EBUSY/EPERM/EMFILE mean we couldn't read RIGHT NOW; the
  // index entry from the prior pass is more accurate than nothing. Schedule
  // a single retry; subsequent watcher events will re-enqueue if still bad.
  const code = res.code ?? 'ENOENT';
  if (code === 'ENOENT') {
    index.remove(relativePath);
    bumpEntry(rel);
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
 * Chunked parallelism for cold-rebuild + bulk applyChanges.
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
  // Optional staleness probe. `rebuild()` passes its generation check so the
  // loop bails between chunks once a newer rebuild supersedes it. `applyChanges`
  // omits it (incremental updates are not generation-scoped).
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

  /** The note's last indexed size, and whether its body was empty (a cut-short read check). */
  knownShape(path: string): { size: number; bodyEmpty: boolean } | undefined {
    const meta = index.get(path);
    if (!meta) return undefined;
    return { size: meta.rawByteSize ?? meta.content.length, bodyEmpty: meta.content.trim() === '' };
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
    // Claim a generation up-front. `isCurrent()` is false the moment
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
      // Only the current generation owns the building flag and the resolver
      // drain; a superseded rebuild returns quietly and the newer one drains
      // when it completes.
      if (isCurrent()) {
        isBuilding = false;
        bump();
        // Cleared in one batch so a resolver that re-enqueues itself doesn't
        // loop on a half-drained list.
        const resolvers = buildCompleteResolvers.splice(0);
        for (const r of resolvers) r();
      }
    }
  },

  /**
   * Resolves once the current `rebuild()` finishes, or immediately when no
   * rebuild is in flight. The recovery sequencer awaits this before sampling
   * `allMetadata()` for partial-tag-rewrite detection — a mid-rebuild sample
   * could miss the carrier that proves a partial commit and offer a Discard
   * that throws away a partially-committed rename.
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
      // A hidden folder (a sync client's `.stversions/` archive) is outside
      // the sidebar tree, so outside search, tag counts and Replace All too.
      if (hasHiddenSegment(rel)) continue;
      // Accept both `.md` and `.markdown` (case-insensitive), matching the
      // watcher classifier, which emits `document` events for both.
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
   * Partial-read-retry hook: when `applyChanges` reads a
   * mid-write truncated file and the classifier flags `partial-read-retry`,
   * the caller restores the prior baseline so the next retry pass compares
   * against the pre-shrink content (preventing classification of the
   * GROWN-back size as another shrink).
   *
   * Bumps `version` so reactive consumers re-render. Pass `null` to drop
   * the entry (mirrors `removePath`).
   */
  restoreMetadata(relativePath: string, metadata: FileMetadata | null): void {
    bumpEntry(normaliseRel(relativePath));
    if (metadata === null) {
      index.remove(relativePath);
    } else {
      index.upsert(metadata);
    }
    bump();
  },

  /**
   * Rebinds an index entry from `oldPath` to `newPath`
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

// Vault-swap reset: drops every cached metadata entry and cancels every in-flight transient-
// read retry timer. The actual rebuild against the new vault tree happens
// inside `vault.svelte.ts:openVault` after hydration, because the rebuild
// has a tag-seeding follow-up that depends on `fileTagsStore` being
// hydrated first.
onVaultSwap('pre-swap', 'vaultIndex', () => {
  for (const timer of pendingRetries.values()) clearTimeout(timer);
  pendingRetries.clear();
  entrySeq.clear();
  index.clear();
  bump();
});
