<script lang="ts">
  /**
   * SmartGuides — renders alignment guide lines on the canvas.
   * Placed inside the canvas transform div so coordinates are in canvas space.
   */
  import { guidesStore } from '../../stores/guides.svelte';

  let guides = $derived(guidesStore.guides);
</script>

{#if guides.length > 0}
  <div class="smart-guides-layer">
    {#each guides as guide (guide.type + ':' + guide.position)}
      <div
        class="smart-guide"
        class:vertical={guide.type === 'vertical'}
        class:horizontal={guide.type === 'horizontal'}
        style={guide.type === 'vertical'
          ? `left: ${guide.position}px`
          : `top: ${guide.position}px`}
      ></div>
    {/each}
  </div>
{/if}

<style>
  .smart-guides-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    z-index: var(--z-toast);
  }

  .smart-guide {
    position: absolute;
    background: var(--accent-primary);
    opacity: 0.6;
  }

  .smart-guide.vertical {
    width: 1px;
    top: -10000px;
    bottom: -10000px;
    height: 20000px;
  }

  .smart-guide.horizontal {
    height: 1px;
    left: -10000px;
    right: -10000px;
    width: 20000px;
  }

  @media (prefers-reduced-motion: reduce) {
    .smart-guide {
      opacity: 0.4;
    }
  }
</style>
