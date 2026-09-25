<script lang="ts">
  /**
   * TileStylePopup — style controls for tile header/body/border colour, shape,
   * border, shadow.
   *
   * Mirrors the patterns from `ConnectionStylePopup` (the canonical style
   * popup): snapshot the editable fields once via `untrack`, write back to
   * the store on each change, and never re-subscribe to the store from the
   * popup itself. A previous `$derived(boardStore.getTile(initialTile.id))`
   * subscription combined with ColorPicker `onchange` writing back into the
   * store created an unbounded reactive cascade.
   *
   * With `tileIds` it styles several tiles at once: the controls are seeded
   * from `tile`, each pick is applied to every listed tile that renders that
   * field (`stylePatchForType`), and closing pushes one undo step for all.
   *
   * Dismissal is via Escape or the close button only — outside-click does
   * NOT close the popup, since unrelated UI clicks (e.g. picker swatches)
   * would dismiss it unexpectedly.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { nanoid } from 'nanoid';
  import type { Tile } from '../../schema/index';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { BatchCommand, UpdateTileStyleCommand } from '../../commands/index';
  import type { Command } from '../../commands/Command';
  import { stylePatchForType, supportsBodyFontSize } from '../../lib/styles/tileStyleSupport';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const popupTitleId = `tile-style-popup-title-${nanoid(6)}`;

  let {
    tile: initialTile,
    tileIds,
    x,
    y,
    onclose,
  }: {
    tile: Tile;
    /** Style several tiles at once. `tile` seeds the controls and is always included. */
    tileIds?: string[];
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // The tiles this session styles, fixed at mount.
  const targetIds: string[] = untrack(() => [...new Set([initialTile.id, ...(tileIds ?? [])])]);
  const popupTitle = targetIds.length > 1 ? `Style: ${targetIds.length} tiles` : 'Tile Style';
  const showBodyFontSize = untrack(() =>
    targetIds.some((id) => {
      const t = boardStore.getTile(id);
      return t ? supportsBodyFontSize(t.type) : false;
    }),
  );

  // Snapshot every target's style at mount so popup-close can push one undo
  // step spanning every pick made during this session. Per-pick history
  // entries would blow through MAX_HISTORY for any meaningful styling session
  // (changing one tile's colour + shape + shadow intensity costs 3 entries),
  // and the user's mental model is "I opened the picker, I undo to close it".
  // JSON round-trip detaches the snapshot from the live Svelte 5 $state
  // Proxy so later store mutations don't leak in.
  const beforeStyles = new Map<string, Tile['style']>(
    untrack(() =>
      targetIds.flatMap((id): [string, Tile['style']][] => {
        const t = boardStore.getTile(id);
        return t ? [[id, JSON.parse(JSON.stringify(t.style))]] : [];
      }),
    ),
  );
  let hasChanged = false;

  // Reads the latest tile from the store at write time (not the
  // mount-time prop snapshot) so concurrent writes from other surfaces
  // — tag editor, external file watcher, undo/redo — are not clobbered
  // when the user picks a colour in the popup.
  function dispatchStyle(patch: Partial<Tile['style']>): void {
    for (const id of targetIds) {
      const current = boardStore.getTile(id);
      if (!current) continue;
      boardStore.updateTile(id, {
        style: { ...current.style, ...stylePatchForType(current.type, patch) },
      });
    }
    hasChanged = true;
  }

  // Restore clears every cascade-able field on the per-element style. Empty
  // strings for required colour fields (headerColor / bodyColor) keep Zod
  // happy while still cascading to the next layer (`resolveStyle` treats ''
  // as unset). For optional fields we write `undefined` so they disappear
  // entirely and the cascade resolves them fresh — `shape`, `borderStyle`,
  // `borderWidth`, `shadowIntensity` are optional in TileStyleSchema (no
  // `.default()`), so Zod's parse no longer re-fills the per-element layer.
  function dispatchClear(): void {
    for (const id of targetIds) {
      if (!boardStore.getTile(id)) continue;
      boardStore.updateTile(id, {
        style: {
          headerColor: '',
          bodyColor: '',
          borderColor: '',
          shape: undefined,
          borderStyle: undefined,
          borderWidth: undefined,
          shadowIntensity: undefined,
          dynamicContrastText: undefined,
          fontSizeTitle: undefined,
          fontSizeBody: undefined,
        } as never,
      });
    }
    hasChanged = true;
  }

  // Snapshot the editable fields once on mount. Bindings read from these
  // local pieces of state — NOT from the store — so the popup doesn't
  // re-render in response to its own writes.
  let headerColor = $state(untrack(() => initialTile.style.headerColor));
  let bodyColor = $state(untrack(() => initialTile.style.bodyColor));
  let borderColor = $state(untrack(() => initialTile.style.borderColor));
  let shape = $state<'rectangle' | 'rounded' | undefined>(untrack(() => initialTile.style.shape));
  let borderStyle = $state<'solid' | 'dashed' | 'dotted' | undefined>(untrack(() => initialTile.style.borderStyle));
  let borderWidth = $state<number | ''>(
    untrack(() => (typeof initialTile.style.borderWidth === 'number' ? initialTile.style.borderWidth : '')),
  );
  let shadowIntensity = $state<number | ''>(
    untrack(() => (typeof initialTile.style.shadowIntensity === 'number' ? initialTile.style.shadowIntensity : '')),
  );
  let dct = $state<'' | 'true' | 'false'>(
    untrack(() => (
      initialTile.style.dynamicContrastText === true
        ? 'true'
        : initialTile.style.dynamicContrastText === false
          ? 'false'
          : ''
    )),
  );
  let fontSizeTitle = $state<number | ''>(
    untrack(() => (typeof initialTile.style.fontSizeTitle === 'number' ? initialTile.style.fontSizeTitle : '')),
  );
  let fontSizeBody = $state<number | ''>(
    untrack(() => (typeof initialTile.style.fontSizeBody === 'number' ? initialTile.style.fontSizeBody : '')),
  );

  // ── Drag state (mirrors ConnectionStylePopup) ──
  let popupEl = $state<HTMLDivElement | null>(null);
  let isDragging = $state(false);
  let dragOffset = $state({ x: 0, y: 0 });
  // Seed from x/y props so the first drag starts from the rendered position
  // without re-measuring via getBoundingClientRect — that would return the
  // popIn-animation-scaled rect and cause a visible 4-5px snap.
  let popupPos = $state(untrack(() => ({ x, y })));
  let hasBeenDragged = $state(false);

  function onDragStart(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.close-btn')) return;
    if ((e.target as HTMLElement).closest('.restore-defaults-btn')) return;
    isDragging = true;
    if (!hasBeenDragged) {
      popupPos = { x, y };
      hasBeenDragged = true;
    }
    dragOffset = { x: e.clientX - popupPos.x, y: e.clientY - popupPos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    popupPos = { x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y };
  }

  function onDragEnd(e: PointerEvent) {
    isDragging = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {
      /* not captured, fine */
    }
  }

  function setHeaderColor(c: string) {
    headerColor = c;
    dispatchStyle({ headerColor: c });
  }

  function setBodyColor(c: string) {
    bodyColor = c;
    dispatchStyle({ bodyColor: c });
  }

  function setBorderColor(c: string) {
    borderColor = c;
    dispatchStyle({ borderColor: c });
  }

  function setShape(value: 'rectangle' | 'rounded' | '') {
    shape = value === '' ? undefined : value;
    dispatchStyle({ shape: shape });
  }

  function setBorderStyle(value: 'solid' | 'dashed' | 'dotted' | '') {
    borderStyle = value === '' ? undefined : value;
    dispatchStyle({ borderStyle: borderStyle });
  }

  function setBorderWidth(raw: string) {
    if (raw === '') {
      borderWidth = '';
      dispatchStyle({ borderWidth: undefined });
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10) {
      borderWidth = n;
      dispatchStyle({ borderWidth: n });
    }
  }

  function setShadowIntensity(value: number) {
    shadowIntensity = value;
    dispatchStyle({ shadowIntensity: value });
  }

  function setDct(value: '' | 'true' | 'false') {
    dct = value;
    dispatchStyle({ dynamicContrastText: value === '' ? undefined : value === 'true' });
  }

  function setFontSizeTitle(raw: string) {
    if (raw === '') {
      fontSizeTitle = '';
      dispatchStyle({ fontSizeTitle: undefined });
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 8 && n <= 48) {
      fontSizeTitle = n;
      dispatchStyle({ fontSizeTitle: n });
    }
  }

  function setFontSizeBody(raw: string) {
    if (raw === '') {
      fontSizeBody = '';
      dispatchStyle({ fontSizeBody: undefined });
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 8 && n <= 48) {
      fontSizeBody = n;
      dispatchStyle({ fontSizeBody: n });
    }
  }

  /**
   * Clear every per-element override so the cascade resolves fresh values
   * from the current board / global defaults on the next paint. Local
   * popup state is cleared (or reset to colour-string '') so the controls
   * fall through to whatever the cascade resolves on the next render —
   * future changes to the global default automatically propagate.
   */
  function restoreDefaults() {
    headerColor = '';
    bodyColor = '';
    borderColor = '';
    shape = undefined;
    borderStyle = undefined;
    borderWidth = '';
    shadowIntensity = '';
    dct = '';
    fontSizeTitle = '';
    fontSizeBody = '';
    dispatchClear();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  // Focus restoration: capture the element that opened the popup so keyboard
  // users return to it when the popup closes (matches Modal.svelte + ContextMenu).
  // Focus trap keeps Tab cycling inside the popup once it has focus.
  let trap: FocusTrap | null = null;
  $effect(() => {
    const triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Capture the board id at popup mount so the deferred command push (in
    // the cleanup below) targets the originating board, not whichever board
    // is active when the popup destroys — otherwise switching boards while
    // the popup is open would push the style command onto the wrong stack.
    // Untracked: a board switch must not rebuild the trap or push the command early.
    const mountBoardId = untrack(() => boardStore.current?.id ?? '');
    if (popupEl) {
      try {
        trap = createFocusTrap(popupEl, {
          escapeDeactivates: false,
          clickOutsideDeactivates: false,
          allowOutsideClick: true,
          fallbackFocus: popupEl,
          initialFocus: false,
        });
        trap.activate();
      } catch { trap = null; }
    }
    return () => {
      safeDeactivateTrap(trap);
      trap = null;
      // Push one undo step for the whole session: an UpdateTileStyleCommand
      // per tile whose style actually changed, batched when there are
      // several. The store mutations have already happened (live preview),
      // so pushWithoutExecute is the right verb: it records the diff for
      // undo/redo without re-running the writes.
      if (hasChanged) {
        const commands: Command[] = [];
        for (const [id, beforeStyle] of beforeStyles) {
          const current = boardStore.getTile(id);
          if (!current) continue;
          const afterStyle: Tile['style'] = JSON.parse(JSON.stringify(current.style));
          if (JSON.stringify(beforeStyle) === JSON.stringify(afterStyle)) continue;
          commands.push(
            new UpdateTileStyleCommand(id, { style: beforeStyle }, { style: afterStyle }, mountBoardId),
          );
        }
        const [only] = commands;
        if (commands.length === 1 && only) {
          historyStore.pushWithoutExecute(only);
        } else if (commands.length > 1) {
          historyStore.pushWithoutExecute(
            new BatchCommand(`Style ${commands.length} tiles`, commands, mountBoardId),
          );
        }
      }
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  use:portal
  class="tile-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px;"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="popup-header"
    onpointerdown={onDragStart}
    onpointermove={onDragMove}
    onpointerup={onDragEnd}
  >
    <span class="popup-title" id={popupTitleId}>{popupTitle}</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>
    Restore to Theme Defaults
  </button>

  <div class="style-row">
    <span>Header Colour</span>
    <ColorPicker value={headerColor} onchange={setHeaderColor} anchorTo={popupEl} />
  </div>

  <div class="style-row">
    <span>Body Colour</span>
    <ColorPicker value={bodyColor} onchange={setBodyColor} anchorTo={popupEl} />
  </div>

  <div class="style-row">
    <span>Border Colour</span>
    <ColorPicker value={borderColor} onchange={setBorderColor} anchorTo={popupEl} />
  </div>

  <div class="style-row">
    <label for="tile-shape">Shape</label>
    <select
      id="tile-shape"
      value={shape ?? ''}
      onchange={(e) => setShape((e.target as HTMLSelectElement).value as 'rectangle' | 'rounded' | '')}
    >
      <option value="">Inherit</option>
      <option value="rectangle">Rectangle</option>
      <option value="rounded">Rounded</option>
    </select>
  </div>

  <div class="style-row">
    <label for="tile-border-style">Border Style</label>
    <select
      id="tile-border-style"
      value={borderStyle ?? ''}
      onchange={(e) => setBorderStyle((e.target as HTMLSelectElement).value as 'solid' | 'dashed' | 'dotted' | '')}
    >
      <option value="">Inherit</option>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <div class="style-row">
    <label for="tile-border-width">Border Width</label>
    <input
      id="tile-border-width"
      class="style-number"
      type="number"
      min="0"
      max="10"
      placeholder="—"
      value={borderWidth}
      onchange={(e) => setBorderWidth((e.target as HTMLInputElement).value)}
    />
  </div>

  <div class="style-row">
    <label for="tile-shadow">Shadow</label>
    <div class="range-with-readout">
      <input
        id="tile-shadow"
        class="style-range"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={shadowIntensity === '' ? 0.3 : shadowIntensity}
        oninput={(e) => setShadowIntensity(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span class="range-value">{Math.round((shadowIntensity === '' ? 0.3 : shadowIntensity) * 100)}%</span>
    </div>
  </div>

  <div class="style-row">
    <label for="tile-dct">Dynamic Contrast Text</label>
    <select id="tile-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="style-row">
    <label for="tile-fs-title">Title Font Size</label>
    <input
      id="tile-fs-title"
      class="style-number"
      type="number"
      min="8"
      max="48"
      placeholder="—"
      value={fontSizeTitle}
      onchange={(e) => setFontSizeTitle((e.target as HTMLInputElement).value)}
    />
  </div>

  {#if showBodyFontSize}
    <div class="style-row">
      <label for="tile-fs-body">Body Font Size</label>
      <input
        id="tile-fs-body"
        class="style-number"
        type="number"
        min="8"
        max="48"
        placeholder="—"
        value={fontSizeBody}
        onchange={(e) => setFontSizeBody((e.target as HTMLInputElement).value)}
      />
    </div>
  {/if}
</div>

<style>
  .tile-style-popup {
    position: fixed;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    padding: 12px;
    min-width: 240px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.15s ease;
    font-size: 12px;
    z-index: var(--z-context-menu-overlay);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .popup-header:active {
    cursor: grabbing;
  }

  .popup-title {
    flex: 1;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    transition: background-color 0.1s ease;
  }

  .close-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .restore-defaults-btn {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.1s ease, color 0.1s ease;
  }

  .restore-defaults-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .style-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    position: relative;
  }

  .style-row label,
  .style-row > span {
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .style-row select {
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    color: var(--text-primary);
    min-width: 90px;
  }

  .style-number {
    width: 50px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 3px 6px;
    color: var(--text-primary);
    font-size: 12px;
    text-align: center;
  }

  .style-range {
    width: 80px;
    accent-color: var(--accent-primary);
  }

  .range-with-readout {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .range-value {
    font-size: 11px;
    color: var(--text-tertiary);
    min-width: 32px;
    text-align: right;
  }

  @media (prefers-reduced-motion: reduce) {
    .tile-style-popup {
      animation: none;
    }
  }
</style>
