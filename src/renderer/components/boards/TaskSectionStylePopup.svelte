<script lang="ts">
  /**
   * TaskSectionStylePopup — per-section style override editor.
   *
   * Mirrors `TileStylePopup` / `KanbanColumnStylePopup`. Writes via
   * `boardCacheStore.updateTaskSectionStyle` so the override lives on
   * the section and feeds `effectiveTaskSectionStyle` at render time.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { nanoid } from 'nanoid';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateTaskSectionStyleCommand } from '../../commands/index';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  const popupTitleId = `ts-style-popup-title-${nanoid(6)}`;

  type SectionStyle = {
    headerColor?: string;
    bodyColor?: string;
    borderColor?: string;
    borderStyle?: 'solid' | 'dashed' | 'dotted';
    borderWidth?: number;
    shadowIntensity?: number;
    dynamicContrastText?: boolean;
    fontSizeTitle?: number;
  };

  let {
    boardId,
    section,
    x,
    y,
    onclose,
  }: {
    boardId: string;
    section: { id: string; style?: SectionStyle };
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Snapshot the whole section style at mount so popup-close can dispatch
  // a single UpdateTaskSectionStyleCommand spanning every pick made during
  // this session. Mirrors TileStylePopup pattern.
  const beforeStyle: SectionStyle = untrack(() =>
    JSON.parse(JSON.stringify(section.style ?? {})),
  );
  let hasChanged = false;
  const initialStyle = untrack(() => (section.style ?? {}) as SectionStyle);
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

  function write(patch: SectionStyle) {
    boardCacheStore.updateTaskSectionStyle(boardId, section.id, patch);
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
    // Inherit ('') writes undefined so the key is dropped on JSON.stringify and
    // the schema's `z.boolean().optional()` is satisfied. Writing `null` would
    // fail Zod parse on the next vault load and reject the whole board.
    write({ dynamicContrastText: v === '' ? undefined : v === 'true' });
  }
  function setFontSizeTitle(raw: string) {
    if (raw === '') { fontSizeTitle = ''; write({ fontSizeTitle: undefined }); return; }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { fontSizeTitle = n; write({ fontSizeTitle: n }); }
  }

  function restoreDefaults() {
    // Clear the section style block entirely; the cascade resolves
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
    boardCacheStore.updateTaskSectionStyle(boardId, section.id, null);
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
      // Push a single UpdateTaskSectionStyleCommand spanning every pick
      // made during this session. Read the live section from the cache
      // so the "after" snapshot reflects exactly what's on screen.
      if (hasChanged) {
        const cached = boardCacheStore.cache[boardId];
        if (cached && cached.board.type === 'tasklist') {
          const tl = cached.board as Record<string, unknown>;
          const sections = (tl.sections ?? []) as Array<{ id: string; style?: SectionStyle }>;
          const sec = sections.find((s) => s.id === section.id);
          const afterStyle: SectionStyle = sec?.style
            ? (JSON.parse(JSON.stringify(sec.style)) as SectionStyle)
            : {};
          if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
            historyStore.pushWithoutExecute(
              new UpdateTaskSectionStyleCommand(boardId, section.id, beforeStyle, afterStyle),
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
  class="ts-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px;"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="popup-header" onpointerdown={onDragStart} onpointermove={onDragMove} onpointerup={onDragEnd}>
    <span class="popup-title" id={popupTitleId}>Section Style</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>Restore to Theme Defaults</button>

  <div class="style-row"><span>Header Colour</span><ColorPicker value={headerColor} onchange={setHeaderColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Body Colour</span><ColorPicker value={bodyColor} onchange={setBodyColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Border Colour</span><ColorPicker value={borderColor} onchange={setBorderColor} anchorTo={popupEl} /></div>

  <div class="style-row">
    <label for="ts-border-style">Border Style</label>
    <select id="ts-border-style" value={borderStyle} onchange={(e) => setBorderStyle((e.target as HTMLSelectElement).value as 'solid' | 'dashed' | 'dotted')}>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <div class="style-row">
    <label for="ts-border-width">Border Width</label>
    <input id="ts-border-width" class="style-number" type="number" min="0" max="10" value={borderWidth} onchange={(e) => setBorderWidth(parseInt((e.target as HTMLInputElement).value) || 0)} />
  </div>

  <div class="style-row">
    <label for="ts-shadow">Shadow</label>
    <div class="range-with-readout">
      <input id="ts-shadow" class="style-range" type="range" min="0" max="1" step="0.05" value={shadowIntensity} oninput={(e) => setShadowIntensity(parseFloat((e.target as HTMLInputElement).value))} />
      <span class="range-value">{Math.round(shadowIntensity * 100)}%</span>
    </div>
  </div>

  <div class="style-row">
    <label for="ts-dct">Dynamic Contrast Text</label>
    <select id="ts-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="style-row">
    <label for="ts-font-size">Title Font Size</label>
    <input id="ts-font-size" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeTitle} onchange={(e) => setFontSizeTitle((e.target as HTMLInputElement).value)} />
  </div>
</div>

<style>
  .ts-style-popup {
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
    .ts-style-popup { animation: none; }
  }
</style>
