<script lang="ts">
  interface Props {
    onselect: (emoji: string) => void;
  }

  let { onselect }: Props = $props();

  let showPicker = $state(false);
  let pickerRef = $state<HTMLDivElement | null>(null);
  let triggerRef = $state<HTMLButtonElement | null>(null);
  let panelRef = $state<HTMLDivElement | null>(null);

  // Panel geometry, recomputed on open + window resize so the panel never
  // renders off-screen (the tab bar, this picker's only consumer, is the
  // bottom-most chrome). The panel is portaled out (escaping any
  // transformed/clipping ancestor) and placed with a viewport-edge clamp,
  // flipping above the trigger when below won't fit.
  const PANEL_WIDTH = 280;
  const PANEL_MAX_HEIGHT = 320;
  const PANEL_GAP = 4;
  let panelPos = $state<{ top: number; left: number }>({ top: 0, left: 0 });

  function updatePanelPos() {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    // Horizontal: align to the trigger's left, clamped inside the viewport.
    let left = rect.left;
    if (left + PANEL_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
    }
    // Vertical: prefer below the trigger; flip above when below won't fit and
    // there's more room above.
    const belowTop = rect.bottom + PANEL_GAP;
    const spaceBelow = window.innerHeight - belowTop - 8;
    const spaceAbove = rect.top - PANEL_GAP - 8;
    let top: number;
    if (spaceBelow >= PANEL_MAX_HEIGHT || spaceBelow >= spaceAbove) {
      top = belowTop;
    } else {
      const height = Math.min(PANEL_MAX_HEIGHT, spaceAbove);
      top = Math.max(8, rect.top - PANEL_GAP - height);
    }
    panelPos = { top, left };
  }

  // Portal the panel to the nearest <dialog> ancestor (top-layer) or body so
  // `position: fixed` escapes any transformed / `overflow: hidden` ancestor.
  // Mirrors ColorPicker.panelPortal.
  function panelPortal(node: HTMLElement) {
    const target = (pickerRef?.closest('dialog') as HTMLElement | null) ?? document.body;
    const origParent = node.parentElement;
    const origNext = node.nextSibling;
    if (target !== origParent) target.appendChild(node);
    return {
      destroy() {
        if (origParent && node.parentElement === target) {
          if (origNext && origNext.parentElement === origParent) {
            origParent.insertBefore(node, origNext);
          } else {
            origParent.appendChild(node);
          }
        }
      },
    };
  }

  // Common emoji categories for board/tab icons
  const categories = [
    { name: 'Smileys', emojis: ['😀','😎','🤔','😍','🤩','😂','🥳','🤖','👻','💀','🔥','✨','💡','⭐','❤️','💜'] },
    { name: 'Objects', emojis: ['📝','📋','📎','📌','🔖','📁','📂','💼','🗂️','📊','📈','🔧','⚙️','🔬','🎯','🏆'] },
    { name: 'Symbols', emojis: ['✅','❌','⚡','🚀','💎','🎨','🎵','🔔','🔑','🏷️','📐','🧩','🧪','🌐','🔮','🎲'] },
    { name: 'Nature', emojis: ['🌱','🌿','🍀','🌸','🌺','🌻','🌲','🍁','🌊','🌙','☀️','⛰️','🏔️','🌈','❄️','🦋'] },
  ];

  // Flat index model for roving-tabindex keyboard nav. Every
  // category shares the same 8-column layout, so the whole picker reads as one
  // continuous grid; `categoryOffsets[ci]` maps a (category, local-index) pair
  // to a single global index. `CLEAR_INDEX` is the trailing "Clear emoji" stop.
  const GRID_COLS = 8;
  const categoryOffsets: number[] = [];
  let emojiCount = 0;
  for (const cat of categories) {
    categoryOffsets.push(emojiCount);
    emojiCount += cat.emojis.length;
  }
  const totalEmojis = emojiCount;
  const CLEAR_INDEX = totalEmojis;

  let emojiButtons = $state<(HTMLButtonElement | null)[]>([]);
  let clearButtonRef = $state<HTMLButtonElement | null>(null);
  let focusedIndex = $state(0);

  function focusTarget(index: number): void {
    if (index >= CLEAR_INDEX) clearButtonRef?.focus();
    else emojiButtons[index]?.focus();
  }

  function selectEmoji(emoji: string) {
    onselect(emoji);
    closePicker();
  }

  function closePicker() {
    if (!showPicker) return;
    showPicker = false;
    triggerRef?.focus();
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Node;
    // The panel is portaled outside `pickerRef`, so check it separately —
    // otherwise a click inside the panel would dismiss it.
    const insideWrapper = pickerRef?.contains(target) ?? false;
    const insidePanel = panelRef?.contains(target) ?? false;
    if (!insideWrapper && !insidePanel) {
      // Route through closePicker so focus returns to the trigger instead of
      // being stranded on <body>.
      closePicker();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
    // Roving-tabindex arrow navigation across the grid + to "Clear
    // emoji". Down from the last emoji row lands on Clear; Up from Clear
    // returns to the last emoji. Enter/Space/Tab fall through to native
    // button behavior.
    let next = focusedIndex;
    switch (e.key) {
      case 'ArrowRight':
        if (focusedIndex < totalEmojis - 1) next = focusedIndex + 1;
        break;
      case 'ArrowLeft':
        if (focusedIndex > 0 && focusedIndex < totalEmojis) next = focusedIndex - 1;
        break;
      case 'ArrowDown':
        if (focusedIndex === CLEAR_INDEX) break;
        next = focusedIndex + GRID_COLS < totalEmojis ? focusedIndex + GRID_COLS : CLEAR_INDEX;
        break;
      case 'ArrowUp':
        if (focusedIndex === CLEAR_INDEX) next = totalEmojis - 1;
        else if (focusedIndex - GRID_COLS >= 0) next = focusedIndex - GRID_COLS;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = totalEmojis - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusedIndex = next;
    focusTarget(next);
  }

  $effect(() => {
    if (showPicker) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });

  // Reposition the panel on open + window resize.
  $effect(() => {
    if (!showPicker) return;
    updatePanelPos();
    const onResize = () => updatePanelPos();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Focus the first emoji when the panel opens so arrow keys work
  // immediately (mirrors ContextMenu/Dropdown). rAF lets the portaled panel
  // finish mounting before we reach into its buttons.
  $effect(() => {
    if (!showPicker) return;
    focusedIndex = 0;
    const raf = requestAnimationFrame(() => emojiButtons[0]?.focus());
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="emoji-picker-wrapper" bind:this={pickerRef}>
  <button
    bind:this={triggerRef}
    class="emoji-trigger"
    onclick={() => showPicker = !showPicker}
    title="Set emoji"
    aria-label="Set emoji"
    aria-expanded={showPicker}
    aria-haspopup="true"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <line x1="9" y1="9" x2="9.01" y2="9"/>
      <line x1="15" y1="9" x2="15.01" y2="9"/>
    </svg>
  </button>

  {#if showPicker}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={panelRef}
      class="emoji-panel"
      role="group"
      aria-label="Pick an emoji"
      tabindex="-1"
      onkeydown={handleKeydown}
      style="top: {panelPos.top}px; left: {panelPos.left}px; z-index: var(--z-dropdown);"
      use:panelPortal
    >
      {#each categories as category, ci (category.name)}
        <div class="emoji-category">
          <span class="category-label">{category.name}</span>
          <div class="emoji-grid">
            {#each category.emojis as emoji, ei (emoji)}
              {@const gi = (categoryOffsets[ci] ?? 0) + ei}
              <button
                class="emoji-btn"
                bind:this={emojiButtons[gi]}
                onclick={() => selectEmoji(emoji)}
                tabindex={focusedIndex === gi ? 0 : -1}
                title={emoji}
              >
                {emoji}
              </button>
            {/each}
          </div>
        </div>
      {/each}
      <div class="emoji-clear">
        <button
          class="clear-btn"
          bind:this={clearButtonRef}
          onclick={() => selectEmoji('')}
          tabindex={focusedIndex === CLEAR_INDEX ? 0 : -1}
        >
          Clear emoji
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .emoji-picker-wrapper {
    position: relative;
    display: inline-flex;
  }

  .emoji-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .emoji-trigger:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .emoji-panel {
    /* Portaled to <dialog>/<body> and positioned via inline top/left from
       updatePanelPos so `position: fixed` escapes any
       transformed / clipping ancestor and the panel stays on-screen. */
    position: fixed;
    width: 280px;
    max-height: 320px;
    padding: 8px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    overflow-y: auto;
    animation: popIn 0.15s ease;
  }

  .emoji-category {
    margin-bottom: 8px;
  }

  .category-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
    padding: 0 2px;
  }

  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
  }

  .emoji-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 4px;
    background: transparent;
    font-size: 18px;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .emoji-btn:hover {
    background: var(--ui-surface-hover);
  }

  .emoji-clear {
    padding-top: 8px;
    border-top: 1px solid var(--ui-border);
    margin-top: 4px;
  }

  .clear-btn {
    width: 100%;
    padding: 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .clear-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }
</style>
