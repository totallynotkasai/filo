<script lang="ts">
  /**
   * TaskListToc — sticky right-rail Table of Contents for the Task List Board.
   *
   * Watches every `[data-section-id]` header inside the supplied scroll
   * container via IntersectionObserver. The header occupying the upper third
   * of the viewport wins the `.active` highlight; clicking a rail entry
   * smooth-scrolls the corresponding header into view.
   *
   * Hidden entirely when there are no sections, and collapsed away on narrow
   * viewports via the parent's CSS.
   */
  import { onDestroy } from 'svelte';

  let {
    sections,
    scrollContainerEl,
  }: {
    sections: Array<{ id: string; title: string }>;
    scrollContainerEl: HTMLElement | undefined;
  } = $props();

  let activeId = $state<string | null>(null);
  let observer: IntersectionObserver | null = null;

  /**
   * Observation has two dependencies: the scroll container (root) and the
   * set of section header elements. Re-running the effect on either change
   * keeps the observer's targets in sync with the rendered sections without
   * holding stale references after a section is added or removed.
   */
  $effect(() => {
    if (!scrollContainerEl) return;
    void sections; // re-run when section list changes

    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) {
          const id = (first.target as HTMLElement).dataset.sectionId;
          if (id) activeId = id;
        }
      },
      {
        root: scrollContainerEl,
        // Trigger active state when the header sits in the top third of the
        // scroll area — feels right when scrolling either direction.
        rootMargin: '-10% 0px -75% 0px',
        threshold: 0,
      },
    );

    // Defer one frame so headers added in the same tick are observable.
    queueMicrotask(() => {
      const headers = scrollContainerEl.querySelectorAll<HTMLElement>('[data-section-id]');
      for (const el of Array.from(headers)) {
        const id = el.dataset.sectionId;
        if (id) observer!.observe(el);
      }
    });
  });

  onDestroy(() => observer?.disconnect());

  function jumpTo(id: string) {
    if (!scrollContainerEl) return;
    const el = scrollContainerEl.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    activeId = id;
  }
</script>

<nav class="tasklist-toc" aria-label="Table of Contents">
  <div class="toc-heading">Table of Contents</div>
  <ul class="toc-list">
    {#each sections as s (s.id)}
      <li>
        <button
          class="toc-link"
          class:active={activeId === s.id}
          onclick={() => jumpTo(s.id)}
          title={s.title}
        >
          {s.title}
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .tasklist-toc {
    padding: 8px 12px;
    box-sizing: border-box;
  }

  .toc-heading {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-tertiary);
    margin: 0 0 8px 12px;
  }

  .toc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .toc-link {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 0 4px 4px 0;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toc-link:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .toc-link.active {
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    border-left-color: var(--accent-primary);
    font-weight: 600;
  }
</style>
