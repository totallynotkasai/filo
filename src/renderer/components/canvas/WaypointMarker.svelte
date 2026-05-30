<script lang="ts">
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasStore = scope.canvas;

  interface Props {
    waypoint: { id: string; name: string; x: number; y: number; icon?: string; locked?: boolean };
  }

  let { waypoint }: Props = $props();

  let showPicker = $state(false);
  let markerRef = $state<HTMLDivElement | null>(null);
  let isDragging = $state(false);

  // Counter-scale to keep marker a fixed visual size regardless of zoom,
  // then multiply by the user's waypoint scale preference so the marker
  // shrinks/grows with the Project Settings slider.
  // `||` (not `??`) so a stored 0 still falls back to 1; clamp the divisor
  // and the final value so the marker can never collapse to scale(0)/NaN
  // (which renders an invisible element).
  let waypointScale = $derived(vaultStore.project?.settings?.general?.waypointScale || 1);
  let counterScale = $derived(Math.max(0.05, (1 / Math.max(0.0001, canvasStore.scale)) * waypointScale));

  // Explicit $derived so Svelte tracks waypoint.icon reactively. When the
  // user hasn't picked an icon yet we render an inline SVG pin (see below)
  // — `displayIcon` therefore holds the user's choice or empty string.
  let displayIcon = $derived(waypoint.icon ?? '');

  // User-selectable waypoint icons. These are content (the user picks one
  // to label their waypoint) rather than chrome (UI affordances), so they
  // are exempt from the "no emojis as icons" rule in CLAUDE.md. The default
  // unpicked waypoint renders an inline SVG pin (see `displayIcon` above).
  const emojiOptions = [
    '📌', '📍', '🔖', '⭐', '🏠', '🏁', '🎯', '🔥',
    '💎', '🚀', '⚡', '🔔', '❤️', '🟢', '🔵', '🟡',
    '🟠', '🟣', '⚪', '🏔️', '🌊', '🌲', '🏰', '🗼',
  ];

  // ── Drag state (plain vars — not reactive, no re-render needed) ──
  let dragStartClient = { x: 0, y: 0 };
  let dragStartPos = { x: 0, y: 0 };
  let pointerDragged = false;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !canvasStore.minimapVisible || waypoint.locked) return;
    if (showPicker) return;
    pointerDragged = false;
    dragStartClient = { x: e.clientX, y: e.clientY };
    dragStartPos = { x: waypoint.x, y: waypoint.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent) {
    if (e.buttons !== 1 || !canvasStore.minimapVisible || waypoint.locked) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    if (!pointerDragged && Math.hypot(dx, dy) > 3) {
      pointerDragged = true;
      isDragging = true;
      showPicker = false;
    }
    if (!pointerDragged) return;
    e.stopPropagation();
    e.preventDefault();
    boardStore.moveWaypoint(
      waypoint.id,
      dragStartPos.x + dx / canvasStore.scale,
      dragStartPos.y + dy / canvasStore.scale,
    );
  }

  function onPointerUp(_e: PointerEvent) {
    // Commit the drag through history so Ctrl+Z restores the pre-drag position.
    // Intermediate moveWaypoint calls in onPointerMove are not history-tracked
    // (they would otherwise produce dozens of entries per drag).
    if (pointerDragged) {
      boardStore.moveWaypointWithHistory(
        waypoint.id,
        { x: dragStartPos.x, y: dragStartPos.y },
        { x: waypoint.x, y: waypoint.y },
      );
    }
    isDragging = false;
  }

  function handleMarkerClick(e: MouseEvent) {
    if (pointerDragged) {
      pointerDragged = false;
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    showPicker = !showPicker;
  }

  function selectIcon(icon: string) {
    const before = waypoint.icon ?? '';
    if (before !== icon) {
      boardStore.updateWaypointIconWithHistory(waypoint.id, before, icon);
    }
    showPicker = false;
  }

  function handleClickOutside(e: MouseEvent) {
    if (markerRef && !markerRef.contains(e.target as Node)) {
      showPicker = false;
    }
  }

  $effect(() => {
    if (showPicker) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="waypoint-marker"
  class:draggable={canvasStore.minimapVisible && !waypoint.locked}
  class:is-dragging={isDragging}
  bind:this={markerRef}
  style="
    left: {waypoint.x}px;
    top: {waypoint.y}px;
    z-index: calc(var(--z-connection-bubbles) + 50);
    transform: translate(-50%, -50%) scale({counterScale});
  "
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onclick={handleMarkerClick}
  title="{waypoint.name}{waypoint.locked ? ' (locked)' : canvasStore.minimapVisible ? ' (drag to reposition, click to change icon)' : ' (click to change icon)'}"
>
  <span class="waypoint-marker-icon" aria-hidden="true">
    {#if displayIcon}
      {displayIcon}
    {:else}
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/>
      </svg>
    {/if}
  </span>
  <span class="waypoint-marker-label">{waypoint.name}</span>

  {#if showPicker}
    <div class="waypoint-icon-picker" onclick={(e) => e.stopPropagation()}>
      <div class="picker-header">Choose Icon</div>
      <div class="picker-grid">
        {#each emojiOptions as emoji (emoji)}
          <button
            class="picker-emoji-btn"
            class:active={displayIcon === emoji}
            onclick={() => selectIcon(emoji)}
            title={emoji}
          >
            {emoji}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .waypoint-marker {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    pointer-events: auto;
    transform-origin: center center;
  }

  .waypoint-marker.draggable {
    cursor: grab;
  }

  .waypoint-marker.draggable.is-dragging {
    cursor: grabbing;
  }

  .waypoint-marker-icon {
    font-size: 24px;
    line-height: 1;
    color: var(--accent-primary, #d04444);
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
    transition: transform 0.1s ease;
  }

  .waypoint-marker-icon svg {
    display: block;
  }

  .waypoint-marker:hover .waypoint-marker-icon {
    transform: scale(1.15);
  }

  .waypoint-marker-label {
    font-size: 10px;
    font-family: var(--font-system);
    color: var(--text-primary);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 3px;
    padding: 1px 5px;
    white-space: nowrap;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  /* ── Icon picker popup ── */
  .waypoint-icon-picker {
    position: absolute;
    top: calc(100% + 8px);
    left: calc(50% - 110px);
    width: 220px;
    padding: 8px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.15s ease;
    z-index: 10;
  }

  .picker-header {
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-system);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
    padding: 0 2px;
  }

  .picker-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 2px;
  }

  .picker-emoji-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    font-size: 18px;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .picker-emoji-btn:hover {
    background: var(--ui-surface-hover);
  }

  .picker-emoji-btn.active {
    background: var(--accent-primary);
    border-radius: 4px;
  }
</style>
