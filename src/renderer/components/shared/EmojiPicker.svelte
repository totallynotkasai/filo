<script lang="ts">
  interface Props {
    onselect: (emoji: string) => void;
  }

  let { onselect }: Props = $props();

  let showPicker = $state(false);
  let pickerRef = $state<HTMLDivElement | null>(null);
  let triggerRef = $state<HTMLButtonElement | null>(null);

  // Common emoji categories for board/tab icons
  const categories = [
    { name: 'Smileys', emojis: ['😀','😎','🤔','😍','🤩','😂','🥳','🤖','👻','💀','🔥','✨','💡','⭐','❤️','💜'] },
    { name: 'Objects', emojis: ['📝','📋','📎','📌','🔖','📁','📂','💼','🗂️','📊','📈','🔧','⚙️','🔬','🎯','🏆'] },
    { name: 'Symbols', emojis: ['✅','❌','⚡','🚀','💎','🎨','🎵','🔔','🔑','🏷️','📐','🧩','🧪','🌐','🔮','🎲'] },
    { name: 'Nature', emojis: ['🌱','🌿','🍀','🌸','🌺','🌻','🌲','🍁','🌊','🌙','☀️','⛰️','🏔️','🌈','❄️','🦋'] },
  ];

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
    if (pickerRef && !pickerRef.contains(e.target as Node)) {
      showPicker = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    }
  }

  $effect(() => {
    if (showPicker) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
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
    <div class="emoji-panel" role="group" aria-label="Pick an emoji" tabindex="-1" onkeydown={handleKeydown}>
      {#each categories as category (category.name)}
        <div class="emoji-category">
          <span class="category-label">{category.name}</span>
          <div class="emoji-grid">
            {#each category.emojis as emoji (emoji)}
              <button
                class="emoji-btn"
                onclick={() => selectEmoji(emoji)}
                title={emoji}
              >
                {emoji}
              </button>
            {/each}
          </div>
        </div>
      {/each}
      <div class="emoji-clear">
        <button class="clear-btn" onclick={() => selectEmoji('')}>
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
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: var(--z-dropdown-panel);
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
