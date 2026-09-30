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
import { KeyedVersions } from '../lib/utils/keyedReactivity.svelte';

/**
 * Reactive wrapper around the VaultIndex. Rebuilds the index on vault open,
 * updates it incrementally from file watcher events, and exposes Svelte 5
 * rune-backed getters that components can read from.
 *
 * Three grains of reactivity, so a save re-runs only what it changed:
 * - `getMetadata(path)` depends on that note's entry alone;
 * - `allTags()` / `listMetadata()` depend on `listVersion`: the set of notes
 *   or some note's tags changed;
 * - `allMetadata()` / `version` depend on every change (search over bodies).
 *
 * A rebuild publishes what it has read every `PUBLISH_THROTTLE_MS`, so the
 * first views fill in while the rest of a large vault is still being read.
 * Batched, not per note: a view of 400 tasks re-derives once per batch, not
 * once for each of its notes as it arrives.
 */

const index = new VaultIndex();
let version = $state(0);
let listVersion = $state(0);
let isBuilding = $state(false);
const entries = new KeyedVersions<VaultPath>();

/** While a rebuild runs, what it has read is published at most this often. */
export const PUBLISH_THROTTLE_MS = 150;
/** A batch of more notes than this tells every reader at once (see `KeyedVersions.bumpAll`). */
const BULK_PUBLISH_KEYS = 32;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
// allow-module-state: notes changed since the last publish; emptied by each flush and the pre-swap clear
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pendingKeys = new Set<VaultPath>();
let pendingAny = false;
let pendingList = false;
/** Open `batchPublishes` runs: while any is open, changes publish on the throttle, as during a rebuild. */
let batching = 0;

function flushPublish(): void {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = null;
  if (pendingKeys.size > BULK_PUBLISH_KEYS) entries.bumpAll();
  else for (const key of pendingKeys) entries.bump(key);
  pendingKeys.clear();
  if (pendingAny) version += 1;
  if (pendingList) listVersion += 1;
  pendingAny = false;
  pendingList = false;
}

/** One note's entry changed; `listChanged`: it came, went, or its tags changed. */
function publish(relativePath: string, listChanged: boolean): void {
  pendingKeys.add(vaultPath(relativePath));
  pendingAny = true;
  if (listChanged) pendingList = true;
  if (!isBuilding && batching === 0) {
    flushPublish();
    return;
  }
  publishTimer ??= setTimeout(flushPublish, PUBLISH_THROTTLE_MS);
}

/** Every entry may have changed (a clear). */
function publishAll(): void {
  pendingKeys.clear();
  entries.reset();
  pendingAny = true;
  pendingList = true;
  flushPublish();
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Puts `metadata` in the index and tells its readers. */
function upsertAndPublish(metadata: FileMetadata): void {
  const prev = index.get(metadata.path);
  index.upsert(metadata);
  publish(metadata.path, !prev || !sameTags(prev.tags, metadata.tags));
}

function removeAndPublish(relativePath: string): void {
  const had = index.has(relativePath);
  index.remove(relativePath);
  if (had) publish(relativePath, true);
}

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

/**
 * Waits before each re-read of a note that couldn't be read (locked, no
 * access). After the last one the index stops trying until the file's next
 * watcher event, so a note that stays unreadable isn't re-read all session.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000];
const pendingRetries = new SvelteMap<string, ReturnType<typeof setTimeout>>();
/** Retries already spent per path; a watcher event starts it again. */
const retriesSpent = new SvelteMap<string, number>();

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
    upsertAndPublish(metadata);
    bumpEntry(rel);
    noteReadEncoding(rel, res.encoding); // a non-UTF-8 note opens non-editable
    noteReadLink(rel, res.link); // so does a symbolic link
    cancelRetry(relativePath);
    return;
  }
  // Only delete the index entry on a true "missing file" signal. EACCES/EBUSY/EPERM/EMFILE mean we couldn't read RIGHT NOW; the
  // index entry from the prior pass is more accurate than nothing.
  const code = res.code ?? 'ENOENT';
  if (code === 'ENOENT') {
    cancelRetry(relativePath);
    removeAndPublish(relativePath);
    bumpEntry(rel);
    return;
  }
  // Transient: keep the existing entry and read again after a growing wait
  // (TRANSIENT_RETRY_DELAYS_MS). One retry in flight per path.
  if (pendingRetries.has(relativePath)) return;
  const spent = retriesSpent.get(relativePath) ?? 0;
  const delay = TRANSIENT_RETRY_DELAYS_MS[spent];
  if (delay === undefined) return;
  retriesSpent.set(relativePath, spent + 1);
  const timer = setTimeout(() => {
    pendingRetries.delete(relativePath);
    void indexOnePath(relativePath);
  }, delay);
  pendingRetries.set(relativePath, timer);
}

function cancelRetry(relativePath: string): void {
  const pending = pendingRetries.get(relativePath);
  if (pending) clearTimeout(pending);
  pendingRetries.delete(relativePath);
  retriesSpent.delete(relativePath);
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

/**
 * Notes a view on screen is waiting for (`prioritize`); the rebuild reads
 * them next. Emptied when a rebuild starts and ends.
 */
// allow-module-state: requests for the running rebuild; cleared at its start and end and by the pre-swap clear
const urgent: string[] = [];

/**
 * The vault-open read: `ordered` in turn, but a note a view asked for
 * (`urgent`) goes in the next chunk. Stops once a newer rebuild supersedes it.
 */
async function rebuildChunked(ordered: string[], isCurrent: () => boolean): Promise<void> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local bookkeeping for this rebuild
  const remaining = new Map(ordered.map((p) => [vaultPath(p), p]));
  let next = 0;
  const take = (key: VaultPath): string | null => {
    const p = remaining.get(key);
    if (p === undefined) return null;
    remaining.delete(key);
    return p;
  };
  while (remaining.size > 0) {
    if (!isCurrent()) return;
    const chunk: string[] = [];
    while (chunk.length < REBUILD_CHUNK_SIZE && urgent.length > 0) {
      const p = take(vaultPath(urgent.shift() as string));
      if (p !== null) chunk.push(p);
    }
    while (chunk.length < REBUILD_CHUNK_SIZE && next < ordered.length) {
      const p = take(vaultPath(ordered[next++] as string));
      if (p !== null) chunk.push(p);
    }
    await Promise.all(chunk.map((rel) => indexOnePath(rel)));
  }
}


export const vaultIndexStore = {
  /**
   * Bumps on every change to any note. Reading it re-runs on every autosave
   * anywhere in the vault: read `getMetadata(path)` for the notes you show,
   * or `listVersion` for the set of notes and their tags. Components and lib
   * need an `// allow-global-index-version: <reason>` marker (gate).
   */
  get version() { void version; return version; },
  /** Bumps when a note comes or goes or a note's tags change. */
  get listVersion() { void listVersion; return listVersion; },
  /** True while the vault is being read at open: entries are still arriving. */
  get isBuilding() { return isBuilding; },

  /**
   * A view is showing these notes before the vault-open read reached them:
   * read them next. A no-op once the read is done.
   */
  prioritize(paths: readonly string[]): void {
    if (!isBuilding) return;
    urgent.push(...paths);
  },

  /** The note's entry; the reader re-runs when this note's entry changes. */
  getMetadata(path: string): FileMetadata | null {
    entries.track(vaultPath(path));
    return index.get(path);
  },

  /** The note's last indexed size, and whether its body was empty (a cut-short read check). */
  knownShape(path: string): { size: number; bodyEmpty: boolean } | undefined {
    const meta = index.get(path);
    if (!meta) return undefined;
    return { size: meta.rawByteSize ?? meta.content.length, bodyEmpty: meta.content.trim() === '' };
  },

  /** Every entry; the reader re-runs on any change to any note. */
  allMetadata(): FileMetadata[] {
    void version;
    return index.allMetadata();
  },

  /**
   * Every entry; the reader re-runs when a note comes or goes or its tags
   * change, not on a body edit. Read a note's other fields through
   * `getMetadata` / the note selectors, which track that note.
   */
  listMetadata(): FileMetadata[] {
    void listVersion;
    return index.allMetadata();
  },

  allTags(): Map<string, number> {
    void listVersion;
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
   * `first`: notes to read before the rest (the ones open boards show).
   */
  async rebuild(tree?: FileTreeNode[], first: readonly string[] = []): Promise<void> {
    if (!vaultStore.path) {
      index.clear();
      publishAll();
      return;
    }
    // Claim a generation up-front. `isCurrent()` is false the moment
    // a newer rebuild() (typically the post-vault-swap one) bumps the counter.
    const myGeneration = ++buildGeneration;
    const isCurrent = (): boolean => myGeneration === buildGeneration;
    const capturedRoot = vaultStore.path;
    isBuilding = true;
    urgent.length = 0;
    try {
      index.clear();
      publishAll();
      const source = tree ?? vaultStore.rawTree;
      const paths = collectMarkdownPaths(source, capturedRoot);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup for this rebuild
      const wanted = new Set(first.map((p) => vaultPath(p)));
      const early = paths.filter((p) => wanted.has(vaultPath(p)));
      const late = paths.filter((p) => !wanted.has(vaultPath(p)));
      await rebuildChunked([...early, ...late], isCurrent);
    } catch (err) {
      reportError('vaultIndex.rebuild', err, 'Failed to rebuild file index — search and tag lookups may be stale');
    } finally {
      // Only the current generation owns the building flag and the resolver
      // drain; a superseded rebuild returns quietly and the newer one drains
      // when it completes.
      if (isCurrent()) {
        isBuilding = false;
        urgent.length = 0;
        flushPublish();
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
  /**
   * Runs `op` with this index's notices batched: a change inside it reaches
   * readers of `version` / `listVersion` at most every
   * `PUBLISH_THROTTLE_MS`, and once more when `op` ends. A tag sweep
   * changes every note that carries the tag, and published one by one, each
   * note re-counted every tag view (the Tags Browser, the sidebar chips).
   */
  async batchPublishes<T>(op: () => Promise<T>): Promise<T> {
    batching += 1;
    try {
      return await op();
    } finally {
      batching = Math.max(0, batching - 1);
      if (batching === 0 && !isBuilding) flushPublish();
    }
  },

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
      // A watcher event for a note the index gave up on starts its retries again.
      retriesSpent.delete(rel);
      toIndex.push(rel);
    }
    await indexPathsChunked(toIndex);
  },

  /**
   * Restores a previously-captured metadata snapshot into the index.
   * Partial-read-retry hook: when `applyChanges` reads a
   * mid-write truncated file and the classifier flags `partial-read-retry`,
   * the caller restores the prior baseline so the next retry pass compares
   * against the pre-shrink content (preventing classification of the
   * GROWN-back size as another shrink).
   *
   * Tells that note's readers (and tag readers when its tags changed). Pass
   * `null` to drop the entry.
   */
  restoreMetadata(relativePath: string, metadata: FileMetadata | null): void {
    bumpEntry(normaliseRel(relativePath));
    if (metadata === null) removeAndPublish(relativePath);
    else upsertAndPublish(metadata);
  },

  /**
   * Rebinds an index entry from `oldPath` to `newPath`
   * without re-reading the file. Called from both in-app rename and
   * `handleExternalRename` so vault search returns the new path without
   * waiting for the next full reindex pass. No-ops if `oldPath` is not
   * indexed (the file was never markdown, or hasn't been read yet).
   */
  renameKey(oldPath: string, newPath: string): void {
    if (!index.has(oldPath)) return;
    index.renameKey(oldPath, newPath);
    publish(oldPath, true);
    publish(newPath, true);
  },

  /** Clears the index entirely (e.g. on vault close). */
  clear(): void {
    index.clear();
    publishAll();
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
  retriesSpent.clear();
  entrySeq.clear();
  urgent.length = 0;
  index.clear();
  publishAll();
});
