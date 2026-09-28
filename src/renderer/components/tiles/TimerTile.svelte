<script lang="ts">
  import type { TimerTile } from '../../schema/index';
  import { onDestroy, getContext, untrack } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { UpdateTimerConfigCommand, type TimerMode, type TimerConfigSnapshot } from '../../commands/index';
  import { timerRemainingAt, startTimerPatch, stopTimerPatch } from '../../lib/utils/timerCountdown';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let { tile }: { tile: TimerTile } = $props();

  let lastTickMs = 0;
  let displayTime = $state('');
  // Last second-stamp we wrote to displayTime. The 100 ms
  // tick is required to keep the countdown accurate, but the display only
  // changes once per second. Skip the formatTime + assignment when the
  // second hasn't changed (clock mode and idle/running countdowns alike).
  let lastDisplaySecond = -1;
  // The time left, recomputed from the tile's wall-clock `endsAt` on every
  // tick. Nothing is written while the countdown runs: the board file holds
  // the end time, so a closed board, a quit or another machine all see the
  // same countdown. The tile is written on start, pause, reset and when it
  // reaches zero.
  // untrack: deliberately snapshot the initial value — the $effect below
  // re-seeds it on genuine external changes, and tick() updates it locally.
  let liveRemaining = $state(untrack(() => timerRemainingAt(tile, Date.now())));
  // True once this view has shown the countdown running with time left, so
  // only a countdown that ends on screen flashes and toasts.
  // DECISION: a countdown that ran out while its board was closed stops
  // quietly on the next mount (the display shows zero); a toast then, perhaps
  // at vault open, would not say which timer it was.
  let countedHere = false;
  // Custom time input state (shown when clicking the display while stopped)
  let editingCustom = $state(false);
  let customInput = $state('');
  let customInputEl = $state<HTMLInputElement | null>(null);

  // End-of-timer cue. `finished` drives a brief flash
  // (transform/opacity only; degrades to a static colour highlight under
  // reduced motion) and `announceText` feeds a visually-hidden aria-live
  // region so a completed countdown is perceivable even when the tile is
  // scrolled off-canvas. Both self-clear after the flash window so the next
  // completion re-triggers the flash and re-announces.
  let finished = $state(false);
  let announceText = $state('');
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function announceFinished(): void {
    finished = true;
    announceText = 'Timer finished';
    uiStore.toast('Timer finished', 'info', 3000);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      finished = false;
      announceText = '';
    }, 1500);
  }

  // The display is only editable (click / Enter → custom-time input) while a
  // non-clock timer is stopped. Drives the role/tabindex + keyboard handler so
  // the affordance is reachable without a mouse.
  let displayEditable = $derived(tile.mode !== 'clock' && !tile.isRunning);

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
  //
  // Compared by value: a board switch hands the tile in as a new object with
  // the same values, and re-seeding then would rewind a running countdown to
  // its last saved value just before the unmount save reads it.
  // A reset while running may leave `remaining` as saved, so `isRunning`
  // is compared too.
  const seedKey = (t: TimerTile): string => `${t.mode}|${t.duration}|${t.remaining}|${t.isRunning}|${t.endsAt ?? ''}`;
  let seeded = untrack(() => seedKey(tile));
  $effect(() => {
    const next = seedKey(tile);
    if (next === seeded) return;
    seeded = next;
    // Re-seed the local countdown whenever the persisted value changes —
    // mode swap, duration set, start, pause, reset, or a reload from disk
    // (another machine started or paused it). liveRemaining is written but
    // not read here, so there is no effect loop.
    liveRemaining = timerRemainingAt(tile, Date.now());
    lastDisplaySecond = -1;
  });

  function configSnapshot(): TimerConfigSnapshot {
    return { mode: tile.mode, duration: tile.duration, remaining: tile.remaining, isRunning: tile.isRunning, endsAt: tile.endsAt };
  }

  // Config changes (mode swap
  // and duration set) route through UpdateTimerConfigCommand so Ctrl+Z
  // reverses them. Transient ticks (remaining countdown, isRunning play
  // / pause) keep their direct boardStore.updateTile calls — wrapping
  // them in commands would blow through MAX_HISTORY on every play.
  function cycleMode() {
    const modes: TimerMode[] = ['hms', 'ms', 's', 'clock'];
    const nextIdx = (modes.indexOf(tile.mode) + 1) % modes.length;
    const before = configSnapshot();
    // A mode swap stops a running countdown where it is, not where it started.
    const after = { ...before, ...stopTimerPatch(tile, Date.now()), mode: modes[nextIdx] ?? tile.mode };
    historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Change timer mode'));
  }

  // allow-direct-mutation: transient play/pause toggle, not history-worthy.
  function toggleRunning() {
    if (tile.mode === 'clock') return;
    const now = Date.now();
    if (tile.isRunning) {
      boardStore.updateTile(tile.id, stopTimerPatch(tile, now));
    } else {
      // Resume: liveRemaining equals the persisted value while paused.
      boardStore.updateTile(tile.id, startTimerPatch(liveRemaining, now));
    }
  }

  function resetTimer() {
    if (tile.mode === 'clock') return;
    // Reset is a deliberate user action — undoable so an accidental press
    // mid-session can be reversed.
    const before = configSnapshot();
    const after = { ...before, remaining: tile.duration, isRunning: false, endsAt: undefined };
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

    if (tileRef.isRunning) {
      // No per-tick write: the time left is read off the stored end time. A
      // board saved without one counts down locally until the interval
      // effect below stamps it.
      liveRemaining = tileRef.endsAt !== undefined
        ? timerRemainingAt(tileRef, now)
        : Math.max(0, liveRemaining - elapsed);
      if (liveRemaining === 0) {
        // allow-direct-mutation: countdown reached zero; persist the stop once.
        boardStore.updateTile(tileRef.id, { remaining: 0, isRunning: false, endsAt: undefined });
        if (countedHere) announceFinished();
      } else {
        countedHere = true;
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
    const before = configSnapshot();
    const after = { ...before, duration: dur, remaining: dur, isRunning: false, endsAt: undefined };
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
      const m = parseInt(parts[0] ?? '', 10) || 0;
      const s = parseInt(parts[1] ?? '', 10) || 0;
      totalMs = (m * 60 + s) * 1000;
    } else if (parts.length === 1) {
      totalMs = (parseInt(parts[0] ?? '', 10) || 0) * 60 * 1000;
    }
    if (totalMs > 0) {
      const before = configSnapshot();
      const after = { ...before, duration: totalMs, remaining: totalMs, isRunning: false, endsAt: undefined };
      historyStore.execute(new UpdateTimerConfigCommand(tile.id, before, after, 'Set timer duration'));
      editingCustom = false;
    } else {
      // Give feedback instead of silently discarding an unparseable
      // value; keep the editor open so the user can correct it.
      uiStore.toast('Enter a time like "25" (minutes) or "25:00" (mm:ss).', 'warning', 3000);
    }
  }

  // Only run the ticking interval when time actually moves: a running
  // countdown needs the 100 ms cadence to stay accurate, clock mode only needs
  // a 1 s tick, and a stopped/paused countdown needs NO interval at all (the
  // display is static until the next user action). The effect re-arms whenever `mode` / `isRunning` flip; the handle
  // lives in the effect's own cleanup so it's cleared on every re-arm + unmount
  // (no component-scope timer binding to leak).
  $effect(() => {
    const mode = tile.mode;
    const running = tile.isRunning;
    // `tick()` reads reactive state (liveRemaining, the cached tile) and the
    // interval mutates it every fire; untrack the body so those reads don't
    // become effect dependencies (which would re-arm the interval on every
    // tick). Only `mode`/`isRunning` above gate the re-arm.
    return untrack(() => {
      // Render once immediately so a mode swap / pause / resume reflects in the
      // display without waiting for the first interval fire.
      lastTickMs = Date.now();
      lastDisplaySecond = -1;
      tick();
      if (mode !== 'clock' && !running) return; // static — no interval
      // A running countdown from a board saved before end times were stored
      // gets one now, so it keeps counting once this board closes.
      const current = boardStore.getTile(tile.id) as TimerTile | undefined;
      if (mode !== 'clock' && running && current?.isRunning && current.endsAt === undefined && liveRemaining > 0) {
        // allow-direct-mutation: stamps the end time of a countdown already running.
        boardStore.updateTile(tile.id, startTimerPatch(liveRemaining, Date.now()));
      }
      const cadence = mode === 'clock' ? 1000 : 100;
      const id = setInterval(tick, cadence);
      return () => clearInterval(id);
    });
  });

  onDestroy(() => {
    // Clear the end-of-timer flash handle so it can't fire after unmount.
    if (flashTimer) clearTimeout(flashTimer);
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
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="display"
      class:clock={tile.mode === 'clock'}
      class:clickable={displayEditable}
      class:finished
      onclick={handleDisplayClick}
      onkeydown={(e) => { if (displayEditable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleDisplayClick(); } }}
      role={displayEditable ? 'button' : undefined}
      tabindex={displayEditable ? 0 : undefined}
      title={displayEditable ? 'Click or press Enter to set custom time' : undefined}
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

  <!-- Visually-hidden live region: announces countdown completion. -->
  <span class="sr-only" aria-live="assertive">{announceText}</span>
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
  /* End-of-timer cue. GPU-friendly (transform/opacity only); the
     accent colour stays as a static highlight so reduced-motion users still
     get a visual cue alongside the aria-live announcement + toast. */
  .display.finished {
    color: var(--accent-primary);
    animation: timerFlash 0.5s ease-in-out 3;
  }
  @keyframes timerFlash {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(1.08); }
  }
  @media (prefers-reduced-motion: reduce) {
    .display.finished { animation: none; }
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
