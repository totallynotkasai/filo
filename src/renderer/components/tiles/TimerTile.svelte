<script lang="ts">
  import type { TimerTile } from '../../schema/index';
  import { onMount, onDestroy, getContext, untrack } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateTimerConfigCommand, type TimerMode } from '../../commands/index';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let { tile }: { tile: TimerTile } = $props();

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastTickMs = 0;
  let displayTime = $state('');
  // Phase 31 C2.4 — last second-stamp we wrote to displayTime. The 100 ms
  // tick is required to keep the countdown accurate, but the display only
  // changes once per second. Skip the formatTime + assignment when the
  // second hasn't changed (clock mode and idle/running countdowns alike).
  let lastDisplaySecond = -1;
  // Audit2 4.1 — the live countdown lives in component state. Persisting the
  // decrement on every 100 ms tick re-armed this board's 300 ms write debounce
  // forever, so the board's writes never flushed: any real edit to the board
  // was lost on a hard crash and the save indicator was pinned on "saving".
  // We now write the tile only on pause / stop / reset / unmount-while-running.
  // untrack: deliberately snapshot the initial value — the $effect below
  // re-seeds it on genuine external changes, and tick() mutates it locally.
  let liveRemaining = $state(untrack(() => tile.remaining));
  // Custom time input state (shown when clicking the display while stopped)
  let editingCustom = $state(false);
  let customInput = $state('');
  let customInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (editingCustom && customInputEl) {
      customInputEl.focus();
      customInputEl.select();
    }
  });

  // Force the next `tick` to re-render `displayTime` when the format the
  // user sees would otherwise be stale: mode swap (hms ↔ ms ↔ s ↔ clock),
  // reset, or preset-duration change. Without this, `lastDisplaySecond`
  // could equal the next computed second and the display would lag a tick.
  $effect(() => {
    void tile.mode;
    void tile.duration;
    // Re-seed the local countdown whenever the persisted value changes from
    // outside our tick — mode swap, duration set, reset, or external reload.
    // A running countdown never writes tile.remaining, so this fires only on
    // genuine external changes, not on our own per-second ticks (liveRemaining
    // is written but not read here, so there is no effect loop).
    liveRemaining = tile.remaining;
    lastDisplaySecond = -1;
  });

  // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — config changes (mode swap
  // and duration set) route through UpdateTimerConfigCommand so Ctrl+Z
  // reverses them. Transient ticks (remaining countdown, isRunning play
  // / pause) keep their direct boardStore.updateTile calls — wrapping
  // them in commands would blow through MAX_HISTORY on every play.
  function cycleMode() {
    const modes: TimerMode[] = ['hms', 'ms', 's', 'clock'];
    const nextIdx = (modes.indexOf(tile.mode) + 1) % modes.length;
    const before = { mode: tile.mode, duration: tile.duration, remaining: tile.remaining, isRunning: tile.isRunning };
    const after = { ...before, mode: modes[nextIdx], isRunning: false };
    historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Change timer mode'));
  }

  // allow-direct-mutation: transient play/pause toggle, not history-worthy.
  function toggleRunning() {
    if (tile.mode === 'clock') return;
    if (tile.isRunning) {
      // Pause — persist the live countdown so it survives reload / board swap.
      boardStore.updateTile(tile.id, { remaining: liveRemaining, isRunning: false });
    } else {
      // Resume — liveRemaining already equals the persisted value while paused.
      boardStore.updateTile(tile.id, { isRunning: true });
    }
  }

  function resetTimer() {
    if (tile.mode === 'clock') return;
    // Reset is a deliberate user action — undoable so an accidental press
    // mid-session can be reversed.
    const before = { mode: tile.mode, duration: tile.duration, remaining: tile.remaining, isRunning: tile.isRunning };
    const after = { ...before, remaining: tile.duration, isRunning: false };
    historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Reset timer'));
  }

  function formatTime(remaining: number, mode: string) {
    if (mode === 'clock') {
      const d = new Date();
      return d.toLocaleTimeString([], { hour12: false });
    }

    const totalSecs = Math.max(0, Math.floor(remaining / 1000));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;

    if (mode === 'hms') {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else if (mode === 'ms') {
      return `${(h * 60 + m).toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else if (mode === 's') {
      return `${totalSecs}s`;
    }
    return '00:00:00';
  }

  function tick() {
    const now = Date.now();
    const elapsed = lastTickMs ? now - lastTickMs : 0;
    lastTickMs = now;

    const tileRef = boardStore.getTile(tile.id) as TimerTile;
    if (!tileRef) return;

    if (tileRef.mode === 'clock') {
      // Wall-clock updates can't change faster than once per second.
      const secondNow = Math.floor(now / 1000);
      if (secondNow !== lastDisplaySecond) {
        lastDisplaySecond = secondNow;
        displayTime = formatTime(0, 'clock');
      }
      return;
    }

    if (tileRef.isRunning && liveRemaining > 0) {
      // Count down in component state only — no per-tick markDirty.
      liveRemaining = Math.max(0, liveRemaining - elapsed);
      if (liveRemaining === 0) {
        // allow-direct-mutation: countdown reached zero; persist the stop once.
        boardStore.updateTile(tileRef.id, { remaining: 0, isRunning: false });
      }
    }
    const remainingSecond = Math.max(0, Math.floor(liveRemaining / 1000));
    if (remainingSecond !== lastDisplaySecond) {
      lastDisplaySecond = remainingSecond;
      displayTime = formatTime(liveRemaining, tileRef.mode);
    }
  }

  function setDuration(minutes: number) {
    const dur = minutes * 60 * 1000;
    const before = { mode: tile.mode, duration: tile.duration, remaining: tile.remaining, isRunning: tile.isRunning };
    const after = { ...before, duration: dur, remaining: dur, isRunning: false };
    historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Set timer duration'));
    editingCustom = false;
  }

  function handleDisplayClick() {
    if (tile.mode === 'clock' || tile.isRunning) return;
    // Populate input with current duration in mm:ss
    const totalSecs = Math.floor(tile.duration / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    customInput = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    editingCustom = true;
  }

  function applyCustomInput() {
    const parts = customInput.trim().split(':');
    let totalMs = 0;
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10) || 0;
      const s = parseInt(parts[1], 10) || 0;
      totalMs = (m * 60 + s) * 1000;
    } else if (parts.length === 1) {
      totalMs = (parseInt(parts[0], 10) || 0) * 60 * 1000;
    }
    if (totalMs > 0) {
      const before = { mode: tile.mode, duration: tile.duration, remaining: tile.remaining, isRunning: tile.isRunning };
      const after = { ...before, duration: totalMs, remaining: totalMs, isRunning: false };
      historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Set timer duration'));
    }
    editingCustom = false;
  }

  onMount(() => {
    // Initialise tick baseline so elapsed starts at 0 on this mount.
    // isRunning is NOT reset here — a timer that was running should keep
    // running when the user switches boards and returns.
    lastTickMs = Date.now();
    tick();
    intervalId = setInterval(tick, 100);
  });

  onDestroy(() => {
    if (intervalId !== null) clearInterval(intervalId);
    // Save countdown progress on unmount (e.g. board switch mid-run) — we
    // don't write per tick, so the cached remaining is otherwise stale.
    if (tile.isRunning && liveRemaining !== tile.remaining) {
      // allow-direct-mutation: persist countdown progress on unmount.
      boardStore.updateTile(tile.id, { remaining: liveRemaining });
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="timer-tile" onpointerdown={(e) => e.stopPropagation()}>
  {#if editingCustom}
    <div class="custom-input-wrap">
      <input
        class="custom-input"
        type="text"
        bind:this={customInputEl}
        bind:value={customInput}
        placeholder="mm:ss"
        onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') applyCustomInput(); if (e.key === 'Escape') editingCustom = false; }}
      />
      <button class="apply-btn" onclick={applyCustomInput}>Set</button>
    </div>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="display"
      class:clock={tile.mode === 'clock'}
      class:clickable={tile.mode !== 'clock' && !tile.isRunning}
      onclick={handleDisplayClick}
      title={tile.mode !== 'clock' && !tile.isRunning ? 'Click to set custom time' : undefined}
    >
      {displayTime}
    </div>
  {/if}

  <div class="controls">
    <button class="icon-btn" onclick={cycleMode} title={`Mode: ${tile.mode.toUpperCase()}`} aria-label={`Cycle mode (current: ${tile.mode.toUpperCase()})`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
      </svg>
    </button>
    {#if tile.mode !== 'clock'}
      <button class="icon-btn" onclick={toggleRunning} title={tile.isRunning ? 'Pause' : 'Play'} aria-label={tile.isRunning ? 'Pause' : 'Play'}>
        {#if tile.isRunning}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        {/if}
      </button>
      <button class="icon-btn" onclick={resetTimer} title="Reset" aria-label="Reset timer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if tile.mode !== 'clock' && !tile.isRunning}
    <div class="presets">
      <button onclick={() => setDuration(5)}>5m</button>
      <button onclick={() => setDuration(15)}>15m</button>
      <button onclick={() => setDuration(25)}>25m</button>
      <button onclick={() => setDuration(60)}>1h</button>
    </div>
  {/if}
</div>

<style>
  .timer-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 16px;
    gap: 12px;
  }
  .display {
    font-size: 42px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 2px;
    color: var(--text-primary);
    line-height: 1;
  }
  .display.clock {
    color: var(--accent-primary);
  }
  .display.clickable {
    cursor: text;
    border-radius: 4px;
    padding: 2px 6px;
  }
  .display.clickable:hover {
    background: var(--ui-surface-hover);
  }
  .custom-input-wrap {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .custom-input {
    width: 90px;
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 2px;
    text-align: center;
    background: var(--ui-surface);
    border: 2px solid var(--accent-primary);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 2px 6px;
  }

  .custom-input:focus:not(:focus-visible) {
    outline: none;
  }
  .apply-btn {
    padding: 4px 10px;
    border-radius: 4px;
    border: none;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .apply-btn:hover {
    background: var(--accent-primary-hover);
  }
  .controls {
    display: flex;
    gap: 8px;
    background: var(--ui-surface);
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--ui-border);
  }
  .icon-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .icon-btn:hover {
    background: var(--ui-surface-hover);
  }
  .presets {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .presets button {
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .presets button:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }
</style>
