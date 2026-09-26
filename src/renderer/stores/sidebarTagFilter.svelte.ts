/**
 * sidebarTagFilter — the tag a click on a sidebar tag chip filters the file
 * tree by. Sidebar view state: never persisted, cleared on vault swap (with
 * the sidebar's name search).
 *
 * While a filter is on, every folder left in the cut-down tree holds a match,
 * so folders show open unless the user collapses one during this filter. The
 * user's own expanded folders (`vaultStore.expandedFolders`) are left alone
 * and come back when the filter clears.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { FileTreeNode } from '../../shared/types';
import type { VaultPath } from '../../shared/vaultPath';
import { filesMatchingTag, filterTreeToFiles, sameTag, type TaggedFile } from '../lib/vault/sidebarTagFilter';
import { isMarkdownExtension } from '../lib/vault/extension';
import { onVaultSwap } from '../core/vaultLifecycle';
import { vaultStore } from './vault.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { noteTags } from './noteMeta';

let activeTag = $state<string | null>(null);
// Absolute tree paths of folders collapsed while this filter is on.
const collapsedFolders = new SvelteSet<string>();

/** Every tagged file: notes by frontmatter, media by `.filo/tags.json`. */
function taggedFiles(): TaggedFile[] {
  const out: TaggedFile[] = vaultIndexStore.allMetadata().map((m) => ({ path: m.path, tags: noteTags(m.path) }));
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
    collapsedFolders.clear();
  },

  clear(): void {
    activeTag = null;
    collapsedFolders.clear();
  },

  /** `nodes` cut down to the matching files and their folders; unchanged with no filter. */
  apply(nodes: FileTreeNode[]): FileTreeNode[] {
    if (matching === null) return nodes;
    return filterTreeToFiles(nodes, vaultStore.path, matching);
  },

  isFolderExpanded(path: string): boolean {
    if (activeTag !== null) return !collapsedFolders.has(path);
    return vaultStore.expandedFolders.has(path);
  },

  toggleFolder(path: string): void {
    if (activeTag === null) {
      vaultStore.toggleFolder(path);
      return;
    }
    if (collapsedFolders.has(path)) collapsedFolders.delete(path);
    else collapsedFolders.add(path);
  },
};

// Both sidebar filters are view state for one vault: a search or tag left
// over from the last vault would hide the next one's files.
onVaultSwap('pre-swap', 'sidebarTagFilter', () => {
  sidebarTagFilter.clear();
  vaultStore.setSearch('');
});
