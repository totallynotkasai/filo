<script lang="ts">
  import { fileTagsStore } from '../../stores/fileTags.svelte';
  import { sidebarTagFilter } from '../../stores/sidebarTagFilter.svelte';
  import { sameTag } from '../../lib/vault/sidebarTagFilter';
  import TagBadge from '../tags/TagBadge.svelte';

  interface Props {
    /** Vault-relative path of the file on this sidebar row. */
    filePath: string;
  }

  let { filePath }: Props = $props();

  // Up to two tags after the filename, with `+N` overflow. A click filters
  // the tree by that tag (the same tag again clears it).
  const VISIBLE = 2;
  const tags = $derived(fileTagsStore.tagsForFile(filePath));
  const visible = $derived(tags.slice(0, VISIBLE));
  const overflow = $derived(Math.max(0, tags.length - VISIBLE));

  function filterByTag(e: MouseEvent, tag: string) {
    // The chip sits inside the row: don't also select or expand it.
    e.stopPropagation();
    sidebarTagFilter.toggle(tag);
  }
</script>

{#if visible.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="file-tag-chips" ondblclick={(e) => e.stopPropagation()}>
    {#each visible as t (t)}
      <TagBadge
        tagName={t}
        size="sm"
        variant="outline"
        ariaLabel="Filter by tag {t}"
        pressed={sidebarTagFilter.tag !== null && sameTag(sidebarTagFilter.tag, t)}
        onClick={(e) => filterByTag(e, t)}
      />
    {/each}
    {#if overflow > 0}
      <span class="file-tag-overflow" title={`+${overflow} more tags`}>+{overflow}</span>
    {/if}
  </span>
{/if}

<style>
  /* Sized like compact outline TagBadges. On a narrow row the chips shrink
     (and later ones clip) before the filename does. */
  .file-tag-chips {
    display: inline-flex;
    align-items: center;
    gap: var(--tag-gap);
    margin-left: 6px;
    flex: 0 1000 auto;
    /* The first chip always stays clickable; later ones may clip. */
    min-width: 2.5em;
    overflow: hidden;
  }
  .file-tag-chips :global(.tag-badge) {
    flex-shrink: 1;
    min-width: 2.5em;
  }
  /* Drawn inside the chip: the clipping container would cut an outer ring. */
  .file-tag-chips :global(.tag-badge:focus-visible) {
    outline-offset: -2px;
  }
  .file-tag-overflow {
    font-size: var(--tag-font-size-sm);
    color: var(--text-tertiary);
    padding: 0 4px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
  }
</style>
