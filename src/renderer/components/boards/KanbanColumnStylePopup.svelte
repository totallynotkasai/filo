<script lang="ts">
  /**
   * KanbanColumnStylePopup — per-column style override editor.
   *
   * Mirrors `TileStylePopup`: snapshot fields once via `untrack`, write
   * back via `boardCacheStore.updateKanbanColumnStyle` on each change so
   * the popup never re-subscribes to its own writes. Drag-the-header,
   * Escape/X close, no outside-click dismissal.
   *
   * Per-column writes go to `KanbanColumn.style` and feed
   * `effectiveColumnStyle` at render time (board → global → empty).
   * Clearing all fields removes the `style` block entirely.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { nanoid } from 'nanoid';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateKanbanColumnStyleCommand } from '../../commands/index';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  const popupTitleId = `kc-style-popup-title-${nanoid(6)}`;

  type ColumnStyle = {
    headerColor?: string;
    bodyColor?: string;
    borderColor?: string;
    borderStyle?: 'solid' | 'dashed' | 'dotted';
    borderWidth?: number;
    shadowIntensity?: number;
    dynamicContrastText?: boolean;
    width?: number;
    fontSizeTitle?: number;
    /** Per-column accent. Falls through to `board.settings.accentColor`
     *  then to the theme default. Drives the column accent bar + the
     *  card-count badge tint. */
    accent?: string;
  };

  let {
    boardId,
    column,
    x,
    y,
    onclose,
  }: {
    boardId: string;
    column: { id: string; style?: ColumnStyle };
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Snapshot the whole column style block at mount so popup-close can
  // dispatch a single UpdateKanbanColumnStyleCommand spanning every pick
  // made during this session. JSON round-trip detaches the snapshot from
  // the live $state Proxy.
  const beforeStyle: ColumnStyle = untrack(() =>
    JSON.parse(JSON.stringify(column.style ?? {})),
  );
  let hasChanged = false;
  const initialStyle = untrack(() => (column.style ?? {}) as ColumnStyle);
  let headerColor = $state<string>(initialStyle.headerColor ?? '');
  let bodyColor = $state<string>(initialStyle.bodyColor ?? '');
  let borderColor = $state<string>(initialStyle.borderColor ?? '');
  let borderStyle = $state<'solid' | 'dashed' | 'dotted'>(initialStyle.borderStyle ?? 'solid');
  let borderWidth = $state<number>(initialStyle.borderWidth ?? 1);
  let shadowIntensity = $state<number>(initialStyle.shadowIntensity ?? 0.3);
  let dct = $state<'' | 'true' | 'false'>(
    initialStyle.dynamicContrastText === true
      ? 'true'
      : initialStyle.dynamicContrastText === false
        ? 'false'
        : '',
  );
  let width = $state<number | ''>(initialStyle.width ?? '');
  let fontSizeTitle = $state<number | ''>(initialStyle.fontSizeTitle ?? '');
  let accent = $state<string>(initialStyle.accent ?? '');

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

  function write(patch: ColumnStyle) {
    boardCacheStore.updateKanbanColumnStyle(boardId, column.id, patch);
    hasChanged = true;
  }

  function setHeaderColor(c: string) { headerColor = c; write({ headerColor: c }); }
  function setBodyColor(c: string) { bodyColor = c; write({ bodyColor: c }); }
  function setAccent(c: string) { accent = c; write({ accent: c }); }
  function setBorderColor(c: string) { borderColor = c; write({ borderColor: c }); }
  function setBorderStyle(v: 'solid' | 'dashed' | 'dotted') { borderStyle = v; write({ borderStyle: v }); }
  function setBorderWidth(v: number) { borderWidth = v; write({ borderWidth: v }); }
  function setShadowIntensity(v: number) { shadowIntensity = v; write({ shadowIntensity: v }); }
  function setDct(v: '' | 'true' | 'false') {
    dct = v;
    // Inherit ('') writes undefined so the key is dropped on JSON.stringify and
    // the schema's `z.boolean().optional()` is satisfied. Writing `null` would
    // fail Zod parse on the next vault load and reject the whole board.
    write({ dynamicContrastText: v === '' ? undefined : v === 'true' });
  }
  function setWidth(raw: string) {
    if (raw === '') { width = ''; write({ width: undefined }); return; }
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) { width = n; write({ width: n }); }
  }
  function setFontSizeTitle(raw: string) {
    if (raw === '') { fontSizeTitle = ''; write({ fontSizeTitle: undefined }); return; }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { fontSizeTitle = n; write({ fontSizeTitle: n }); }
  }

  function restoreDefaults() {
    // Clear the column style block entirely; the cascade resolves fresh
    // values on the next render. Local state is reset to defaults so the
    // controls visibly snap back during the popup's animation.
    headerColor = '';
    bodyColor = '';
    borderColor = '';
    borderStyle = 'solid';
    borderWidth = 1;
    shadowIntensity = 0.3;
    dct = '';
    width = '';
    fontSizeTitle = '';
    accent = '';
    boardCacheStore.updateKanbanColumnStyle(boardId, column.id, null);
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
      // Push a single UpdateKanbanColumnStyleCommand spanning every pick
      // made during this session. Read the live column from the cache so
      // the "after" snapshot reflects exactly what's on screen.
      if (hasChanged) {
        const cached = boardCacheStore.cache[boardId];
        if (cached && cached.board.type === 'kanban') {
          const kb = cached.board as Record<string, unknown>;
          const columns = (kb.columns ?? []) as Array<{ id: string; style?: ColumnStyle }>;
          const col = columns.find((c) => c.id === column.id);
          const afterStyle: ColumnStyle = col?.style
            ? (JSON.parse(JSON.stringify(col.style)) as ColumnStyle)
            : {};
          if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
            historyStore.pushWithoutExecute(
              new UpdateKanbanColumnStyleCommand(boardId, column.id, beforeStyle, afterStyle),
            );
          }
        }
      }
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });

  // Acknowledge boardStore dependency so the popup picks up board-id changes
  // if the user swaps panes while the popup is open.
  void boardStore.current;
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  use:portal
  class="kc-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px;"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="popup-header" onpointerdown={onDragStart} onpointermove={onDragMove} onpointerup={onDragEnd}>
    <span class="popup-title" id={popupTitleId}>Column Style</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>Restore to Theme Defaults</button>

  <div class="style-row"><span>Header Colour</span><ColorPicker value={headerColor} onchange={setHeaderColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Body Colour</span><ColorPicker value={bodyColor} onchange={setBodyColor} anchorTo={popupEl} /></div>
  <!-- Per-column accent — drives the header accent bar AND the
       card-count badge tint. Empty falls through to the board-level
       accent (`settings.accentColor`) and finally the theme default. -->
  <div class="style-row"><span>Accent</span><ColorPicker value={accent} onchange={setAccent} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Border Colour</span><ColorPicker value={borderColor} onchange={setBorderColor} anchorTo={popupEl} /></div>

  <div class="style-row">
    <label for="kc-border-style">Border Style</label>
    <select id="kc-border-style" value={borderStyle} onchange={(e) => setBorderStyle((e.target as HTMLSelectElement).value as 'solid' | 'dashed' | 'dotted')}>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <div class="style-row">
    <label for="kc-border-width">Border Width</label>
    <input id="kc-border-width" class="style-number" type="number" min="0" max="10" value={borderWidth} onchange={(e) => setBorderWidth(parseInt((e.target as HTMLInputElement).value) || 0)} />
  </div>

  <div class="style-row">
    <label for="kc-shadow">Shadow</label>
    <div class="range-with-readout">
      <input id="kc-shadow" class="style-range" type="range" min="0" max="1" step="0.05" value={shadowIntensity} oninput={(e) => setShadowIntensity(parseFloat((e.target as HTMLInputElement).value))} />
      <span class="range-value">{Math.round(shadowIntensity * 100)}%</span>
    </div>
  </div>

  <div class="style-row">
    <label for="kc-dct">Dynamic Contrast Text</label>
    <select id="kc-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="style-row">
    <label for="kc-width">Column Width (px)</label>
    <input id="kc-width" class="style-number" type="number" min="120" max="2000" step="10" placeholder="—" value={width} onchange={(e) => setWidth((e.target as HTMLInputElement).value)} />
  </div>

  <div class="style-row">
    <label for="kc-font-size">Title Font Size</label>
    <input id="kc-font-size" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeTitle} onchange={(e) => setFontSizeTitle((e.target as HTMLInputElement).value)} />
  </div>
</div>

<style>
  .kc-style-popup {
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
    .kc-style-popup { animation: none; }
  }
</style>
