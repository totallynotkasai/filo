import { SvelteSet } from 'svelte/reactivity';
import type { FileTreeNode } from '../../shared/types';
import { fileTagsStore } from './fileTags.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { uiStore } from './ui.svelte';
import { emptyTagsFile } from '../lib/vault/tagsStorage';
import { DEFAULT_TAG_COLOR } from '../constants/defaults';
import { flattenTreePaths } from '../lib/vault/vaultTreeSort';
import { isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { namedByPendingRename, type ReadResult } from '../lib/vault/renameCascadeSentinel';

/**
 * The tag registry's housekeeping after a vault opens: seed an empty
 * `.filo/tags.json` from the notes' frontmatter tags, or else drop
 * `fileTags` entries whose file is gone and report tag references the
 * registry doesn't define.
 */
export interface OpenTagHousekeeping {
  identity: VaultIdentity;
  vaultRoot: string;
  /** The live sidebar tree (read when the prune runs, not when the vault opened). */
  tree: () => FileTreeNode[];
  /** The vault index rebuild. */
  rebuilt: Promise<void>;
  /** The open-time recovery prompts (the rename-cascade Retry among them). */
  recovered: Promise<void>;
  /** The rename-cascade sentinel as it was when the vault opened. */
  pendingRenames: Promise<ReadResult>;
}

export async function tidyTagsAfterOpen(args: OpenTagHousekeeping): Promise<void> {
  await args.rebuilt;
  // Vault-identity guard. The rebuild yields, so an A→B swap can leave the
  // tree pointing at B while `vaultRoot` is still A — pruning B's tags against
  // A's prefix would drop every entry and save them into B's tags.json.
  if (!isStillSameVault(args.identity)) return;
  if (fileTagsStore.isEmpty()) {
    seedRegistryFromNotes();
    return;
  }
  // Prune only after the recovery prompts: an unfinished rename's Retry moves
  // attachment tags to the new path, and a prune before it would drop them
  // for good (they have no other copy). Paths the sentinel named when the
  // vault opened stay, whatever the prompt's answer: Discard only drops the
  // breadcrumb, and the file may still be arriving from a sync client.
  await args.recovered.catch(() => undefined);
  const pending = await args.pendingRenames.catch((): ReadResult => ({}));
  if (!isStillSameVault(args.identity)) return;
  // The LIVE tree, not the load-time one: a file added or moved since would
  // otherwise lose its tag entry.
  const flat = flattenTreePaths(args.tree(), args.vaultRoot);
  const dropped = fileTagsStore.pruneOrphanFileTags(flat, namedByPendingRename(pending.entries ?? []));
  if (dropped.length > 0) {
    uiStore.toast(
      `Pruned ${dropped.length} stale tag entr${dropped.length === 1 ? 'y' : 'ies'} from .filo/tags.json (files no longer in the vault).`,
      'info',
      5000,
    );
  }
  // Surface drift: orphan tag references (a tile or file points at a tag
  // name that has no registry entry).
  const { tile, file } = fileTagsStore.detectOrphans();
  if (tile + file > 0) {
    uiStore.toast(
      `Found ${tile + file} undefined tag reference${tile + file === 1 ? '' : 's'} (${tile} on tiles, ${file} on files). Open the Tags Browser to review.`,
      'warning',
      7000,
    );
  }
}

/**
 * tags.json was empty — seed the tag registry from the frontmatter tags the
 * index rebuild found. A note's tags themselves stay in its file.
 */
function seedRegistryFromNotes(): void {
  const seed = emptyTagsFile();
  let mutated = false;
  for (const md of vaultIndexStore.allMetadata()) { // allow-global-index-version: a one-off read at open, not a derived
    if (md.tags.length === 0) continue;
    const unique = Array.from(new SvelteSet(
      md.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
    ));
    if (unique.length === 0) continue;
    for (const t of unique) {
      if (!seed.tags[t]) seed.tags[t] = { color: DEFAULT_TAG_COLOR, createdAt: Date.now() };
    }
    mutated = true;
  }
  if (mutated) fileTagsStore.setAll(seed);
}
