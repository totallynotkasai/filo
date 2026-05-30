<script lang="ts">
  /**
   * TaskItemStylePopup — per-task placement style override editor.
   *
   * Mirrors `TaskSectionStylePopup`. Writes via
   * `boardCacheStore.updateTaskPlacementStyle` so the override lives on
   * the TaskPlacement and feeds `effectiveTaskStyle` at render time.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { nanoid } from 'nanoid';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateTaskItemStyleCommand } from '../../commands/index';
  import type { PartialTaskStyle } from '../../schema/index';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  const popupTitleId = `ti-style-popup-title-${nanoid(6)}`;

  let {
    boardId,
    tileId,
    style,
    x,
    y,
    onclose,
  }: {
    boardId: string;
    tileId: string;
    style?: PartialTaskStyle;
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Snapshot the whole style block at mount so popup-close can dispatch a
  // single UpdateTaskItemStyleCommand spanning every pick made during
  // this session. Mirrors TileStylePopup pattern.
  const beforeStyle: PartialTaskStyle = untrack(() =>
    JSON.parse(JSON.stringify(style ?? {})),
  );
  let hasChanged = false;
  const initialStyle = untrack(() => (style ?? {}) as PartialTaskStyle);
  let headerColor = $state<string>(initialStyle.headerColor ?? '');
  let bodyColor = $state<string>(initialStyle.bodyColor ?? '');
  let borderColor = $state<string>(initialStyle.borderColor ?? '');
  let borderStyle = $state<'solid' | 'dashed' | 'dotted'>(initialStyle.borderStyle ?? 'solid');
  let borderWidth = $state<number>(initialStyle.borderWidth ?? 1);
  let shadowIntensity = $state<number>(initialStyle.shadowIntensity ?? 0.2);
  let dct = $state<'' | 'true' | 'false'>(
    initialStyle.dynamicContrastText === true
      ? 'true'
      : initialStyle.dynamicContrastText === false
        ? 'false'
        : '',
  );
  let fontSizeTitle = $state<number | ''>(initialStyle.fontSizeTitle ?? '');
  let fontSizeBody = $state<number | ''>(initialStyle.fontSizeBody ?? '');

  let popupEl = $state<HTMLDivElement | null>(null);
  let isDragging = $state(false);
  let dragOffset = $state({ x: 0, y: 0 });
  let popupPos = $state(untrack(() => ({ x, y })));
  let hasBeenDragged = $state(false);

  function onDragStart(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.close-btn')) return;
    if ((e.target as HTMLElement).closest('.restore-defaults-btn')) return;
    isDragging = true;
    if (!hasBeenDragged) { popupPos = { x, y }; hasBeenDragged = true; }
    dragOffset = { x: e.clientX - popupPos.x, y: e.clientY - popupPos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: PointerEvent) {
    if (!isDragging) return;
    popupPos = { x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y };
  }
  function onDragEnd(e: PointerEvent) {
    isDragging = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }

  function write(patch: PartialTaskStyle) {
    boardCacheStore.updateTaskPlacementStyle(boardId, tileId, patch);
    hasChanged = true;
  }

  function setHeaderColor(c: string) { headerColor = c; write({ headerColor: c }); }
  function setBodyColor(c: string) { bodyColor = c; write({ bodyColor: c }); }
  function setBorderColor(c: string) { borderColor = c; write({ borderColor: c }); }
  function setBorderStyle(v: 'solid' | 'dashed' | 'dotted') { borderStyle = v; write({ borderStyle: v }); }
  function setBorderWidth(v: number) { borderWidth = v; write({ borderWidth: v }); }
  function setShadowIntensity(v: number) { shadowIntensity = v; write({ shadowIntensity: v }); }
  function setDct(v: '' | 'true' | 'false') {
    dct = v;
    write({ dynamicContrastText: v === '' ? undefined : v === 'true' });
  }
  function setFontSizeTitle(raw: string) {
    if (raw === '') { fontSizeTitle = ''; write({ fontSizeTitle: undefined }); return; }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { fontSizeTitle = n; write({ fontSizeTitle: n }); }
  }
  function setFontSizeBody(raw: string) {
    if (raw === '') { fontSizeBody = ''; write({ fontSizeBody: undefined }); return; }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { fontSizeBody = n; write({ fontSizeBody: n }); }
  }

  function restoreDefaults() {
    // Clear the placement style block entirely; the cascade resolves
    // fresh values on the next render. Local state is reset to defaults
    // so the controls visibly snap back during the popup's animation.
    headerColor = '';
    bodyColor = '';
    borderColor = '';
    borderStyle = 'solid';
    borderWidth = 1;
    shadowIntensity = 0.2;
    dct = '';
    fontSizeTitle = '';
    fontSizeBody = '';
    boardCacheStore.updateTaskPlacementStyle(boardId, tileId, null);
    hasChanged = true;
  }

  function handleKeydown(e: KeyboardEvent) { if (e.key === 'Escape') onclose(); }

  let trap: FocusTrap | null = null;
  $effect(() => {
    const triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      // Push a single UpdateTaskItemStyleCommand spanning every pick made
      // during this session. Read the live placement from the cache so
      // the "after" snapshot reflects exactly what's on screen.
      if (hasChanged) {
        const cached = boardCacheStore.cache[boardId];
        if (cached && cached.board.type === 'tasklist') {
          const tl = cached.board as Record<string, unknown>;
          const tasks = (tl.tasks ?? []) as Array<{ tileId: string; style?: PartialTaskStyle }>;
          const placement = tasks.find((p) => p.tileId === tileId);
          const afterStyle: PartialTaskStyle = placement?.style
            ? (JSON.parse(JSON.stringify(placement.style)) as PartialTaskStyle)
            : {};
          if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
            historyStore.pushWithoutExecute(
              new UpdateTaskItemStyleCommand(boardId, tileId, beforeStyle, afterStyle),
            );
          }
        }
      }
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });

  void boardStore.current;
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  use:portal
  class="ti-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px;"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="popup-header" onpointerdown={onDragStart} onpointermove={onDragMove} onpointerup={onDragEnd}>
    <span class="popup-title" id={popupTitleId}>Task Style</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>Restore to Theme Defaults</button>

  <div class="style-row"><span>Header Colour</span><ColorPicker value={headerColor} onchange={setHeaderColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Body Colour</span><ColorPicker value={bodyColor} onchange={setBodyColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Border Colour</span><ColorPicker value={borderColor} onchange={setBorderColor} anchorTo={popupEl} /></div>

  <div class="style-row">
    <label for="ti-border-style">Border Style</label>
    <select id="ti-border-style" value={borderStyle} onchange={(e) => setBorderStyle((e.target as HTMLSelectElement).value as 'solid' | 'dashed' | 'dotted')}>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <div class="style-row">
    <label for="ti-border-width">Border Width</label>
    <input id="ti-border-width" class="style-number" type="number" min="0" max="10" value={borderWidth} onchange={(e) => setBorderWidth(parseInt((e.target as HTMLInputElement).value) || 0)} />
  </div>

  <div class="style-row">
    <label for="ti-shadow">Shadow</label>
    <div class="range-with-readout">
      <input id="ti-shadow" class="style-range" type="range" min="0" max="1" step="0.05" value={shadowIntensity} oninput={(e) => setShadowIntensity(parseFloat((e.target as HTMLInputElement).value))} />
      <span class="range-value">{Math.round(shadowIntensity * 100)}%</span>
    </div>
  </div>

  <div class="style-row">
    <label for="ti-dct">Dynamic Contrast Text</label>
    <select id="ti-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="style-row">
    <label for="ti-font-title">Title Font Size</label>
    <input id="ti-font-title" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeTitle} onchange={(e) => setFontSizeTitle((e.target as HTMLInputElement).value)} />
  </div>

  <div class="style-row">
    <label for="ti-font-body">Body Font Size</label>
    <input id="ti-font-body" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeBody} onchange={(e) => setFontSizeBody((e.target as HTMLInputElement).value)} />
  </div>
</div>

<style>
  .ti-style-popup {
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
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .popup-header:active { cursor: grabbing; }
  .popup-title { flex: 1; }

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
    transition: background-color 0.1s ease;
  }
  .close-btn:hover { background: var(--ui-surface-hover); color: var(--text-primary); }

  .restore-defaults-btn {
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 11px;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }
  .restore-defaults-btn:hover { background: var(--ui-surface-raised); border-color: var(--accent-primary); }

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

  .style-row select,
  .style-number {
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    color: var(--text-primary);
    min-width: 90px;
  }

  .style-number {
    width: 90px;
    text-align: center;
    font-family: var(--font-system);
  }

  .style-range {
    width: 90px;
    accent-color: var(--accent-primary);
    cursor: pointer;
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
    .ti-style-popup { animation: none; }
  }
</style>
