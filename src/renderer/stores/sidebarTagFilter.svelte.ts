/**
 * sidebarTagFilter — the tag a click on a sidebar tag chip filters the file
 * tree by. Sidebar view state: never persisted, cleared on vault swap (with
 * the sidebar's name search).
 *
 * While a filter is on (this tag, or the sidebar's name search) the folders
 * leading to a match show open: with a tag, every folder left in the cut-down
 * tree; with a name search, those above a match and a folder whose name
 * matches (not the folders inside it, unless they hold a match too). The
 * user can open or close any of them during this filter. The user's own
 * expanded folders (`vaultStore.expandedFolders`) are left alone and come
 * back when the filter clears.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { FileTreeNode } from '../../shared/types';
import type { VaultPath } from '../../shared/vaultPath';
import { filesMatchingTag, filterTreeToFiles, sameTag, type TaggedFile } from '../lib/vault/sidebarTagFilter';
import { isMarkdownExtension } from '../lib/vault/extension';
import { foldersOpenForSearch } from '../lib/vault/vaultTreeSort';
import { onVaultSwap } from '../core/vaultLifecycle';
import { vaultStore } from './vault.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { noteTags } from './noteMeta';

let activeTag = $state<string | null>(null);
// Absolute tree paths of folders the user opened or closed (flipped from how
// the filter shows them) while this filter is on, and the filter they were
// flipped under: a new tag or search query starts from its own defaults.
const flippedFolders = new SvelteSet<string>();
let flippedUnder = $state('');

/** The tag and the name search, as one key; empty while neither filters. */
function filterKey(): string {
  const search = vaultStore.search;
  if (activeTag === null && search === '') return '';
  return JSON.stringify([activeTag, search]);
}

/** The folders flipped under the current filter (reset when it changed). */
function flippedNow(): SvelteSet<string> {
  const key = filterKey();
  if (flippedUnder !== key) {
    flippedFolders.clear();
    flippedUnder = key;
  }
  return flippedFolders;
}

/**
 * The folders the current filter shows open before the user flips any:
 * every one (`null`) under a tag alone, else those a name search leads to.
 */
const openByDefault = $derived.by((): ReadonlySet<string> | null => {
  const search = vaultStore.search;
  return search === '' ? null : foldersOpenForSearch(sidebarTagFilter.apply(vaultStore.tree), search);
});

function isOpenUnderFilter(path: string): boolean {
  const byDefault = openByDefault === null || openByDefault.has(path);
  const flipped = flippedUnder === filterKey() && flippedFolders.has(path);
  return byDefault !== flipped;
}

/** Every tagged file: notes by frontmatter, media by `.filo/tags.json`. */
function taggedFiles(): TaggedFile[] {
  const out: TaggedFile[] = vaultIndexStore.listMetadata().map((m) => ({ path: m.path, tags: noteTags(m.path) }));
  for (const [path, tags] of Object.entries(fileTagsStore.file.fileTags)) {
    // A note's tags live only in its frontmatter; a stray tags.json entry for one is ignored.
    const dot = path.lastIndexOf('.');
    if (dot < 0 || !isMarkdownExtension(path.slice(dot))) out.push({ path, tags });
  }
  return out;
}

const matching = $derived.by((): ReadonlySet<VaultPath> | null =>
  activeTag === null ? null : filesMatchingTag(activeTag, taggedFiles()),
);

export const sidebarTagFilter = {
  get tag(): string | null { return activeTag; },
  get active(): boolean { return activeTag !== null; },

  /** Filter by `tag`; the tag already filtered by clears it instead. */
  toggle(tag: string): void {
    if (activeTag !== null && sameTag(activeTag, tag)) {
      this.clear();
      return;
    }
    activeTag = tag;
  },

  clear(): void {
    activeTag = null;
  },

  /** `nodes` cut down to the matching files and their folders; unchanged with no filter. */
  apply(nodes: FileTreeNode[]): FileTreeNode[] {
    if (matching === null) return nodes;
    return filterTreeToFiles(nodes, vaultStore.path, matching);
  },

  isFolderExpanded(path: string): boolean {
    if (filterKey() !== '') return isOpenUnderFilter(path);
    return vaultStore.expandedFolders.has(path);
  },

  toggleFolder(path: string): void {
    if (filterKey() === '') {
      vaultStore.toggleFolder(path);
      return;
    }
    const flipped = flippedNow();
    if (flipped.has(path)) flipped.delete(path);
    else flipped.add(path);
  },

  /**
   * The folders the sidebar shows right now. Expand / Collapse All work on
   * these: while filtering, the user's own expanded set isn't what's on
   * screen, and changing it would only show once the filter clears.
   */
  get hasFolders(): boolean {
    return folderPaths(this.apply(vaultStore.tree)).length > 0;
  },

  get anyFolderExpanded(): boolean {
    if (filterKey() === '') return vaultStore.expandedFolders.size > 0;
    return folderPaths(this.apply(vaultStore.tree)).some((p) => isOpenUnderFilter(p));
  },

  expandAll(): void {
    if (filterKey() === '') {
      vaultStore.expandAll();
      return;
    }
    this.setAllShown(true);
  },

  collapseAll(): void {
    if (filterKey() === '') {
      vaultStore.collapseAll();
      return;
    }
    this.setAllShown(false);
  },

  /** Every folder the filter shows, open or closed (flipped where that isn't its default). */
  setAllShown(open: boolean): void {
    const flipped = flippedNow();
    flipped.clear();
    for (const p of folderPaths(this.apply(vaultStore.tree))) {
      const byDefault = openByDefault === null || openByDefault.has(p);
      if (byDefault !== open) flipped.add(p);
    }
  },
};

function folderPaths(nodes: readonly FileTreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (!n.isDirectory) continue;
    out.push(n.path);
    folderPaths(n.children ?? [], out);
  }
  return out;
}

// Both sidebar filters are view state for one vault: a search or tag left
// over from the last vault would hide the next one's files.
onVaultSwap('pre-swap', 'sidebarTagFilter', () => {
  sidebarTagFilter.clear();
  vaultStore.setSearch('');
});
