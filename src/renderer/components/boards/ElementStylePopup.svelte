<script lang="ts">
  /**
   * ElementStylePopup — the style override editor for a Kanban card or
   * column and a Task List task or section. `kind` picks the rows, the
   * write target and the undo command (`lib/styles/elementStyleTargets.ts`).
   *
   * Snapshots the fields once via `untrack` and writes each pick straight to
   * the board cache, so the popup never re-subscribes to its own writes.
   * Drag the header to move it; Escape or X closes it; an outside click
   * does not.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { createId } from '../../lib/utils/ids';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import {
    ELEMENT_STYLE_TARGETS,
    type ElementStyle,
    type ElementStyleKind,
  } from '../../lib/styles/elementStyleTargets';
  import type { BorderStyle, Shape } from '../../schema/styleEnums';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let {
    kind,
    boardId,
    elementId,
    style,
    x,
    y,
    onclose,
  }: {
    kind: ElementStyleKind;
    boardId: string;
    /** The card's or task's tileId, or the column's or section's id. */
    elementId: string;
    style?: ElementStyle;
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Each call site passes one fixed kind.
  const target = untrack(() => ELEMENT_STYLE_TARGETS[kind]);
  const fields = target.fields;
  const p = target.idPrefix;

  const popupTitleId = `${p}-style-popup-title-${createId()}`;

  // Snapshot the whole style block at mount so popup-close can dispatch a
  // single style command spanning every pick made during this session. The
  // JSON round-trip detaches the snapshot from the live $state Proxy so
  // later store mutations don't leak in.
  const beforeStyle: ElementStyle = untrack(() =>
    JSON.parse(JSON.stringify(style ?? {})),
  );
  let hasChanged = false;
  const initialStyle: ElementStyle = untrack(() => style ?? {});
  let backgroundColor = $state<string>(initialStyle.backgroundColor ?? '');
  let headerColor = $state<string>(initialStyle.headerColor ?? '');
  let bodyColor = $state<string>(initialStyle.bodyColor ?? '');
  let shape = $state<Shape | ''>(initialStyle.shape ?? '');
  let accent = $state<string>(initialStyle.accent ?? '');
  let borderColor = $state<string>(initialStyle.borderColor ?? '');
  let borderStyle = $state<BorderStyle>(initialStyle.borderStyle ?? 'solid');
  let borderWidth = $state<number>(initialStyle.borderWidth ?? 1);
  let shadowIntensity = $state<number>(initialStyle.shadowIntensity ?? target.defaultShadow);
  let dct = $state<'' | 'true' | 'false'>(
    initialStyle.dynamicContrastText === true
      ? 'true'
      : initialStyle.dynamicContrastText === false
        ? 'false'
        : '',
  );
  let width = $state<number | ''>(initialStyle.width ?? '');
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

  function write(patch: ElementStyle) {
    target.write(boardId, elementId, patch);
    hasChanged = true;
  }

  function setBackgroundColor(c: string) { backgroundColor = c; write({ backgroundColor: c }); }
  function setHeaderColor(c: string) { headerColor = c; write({ headerColor: c }); }
  function setBodyColor(c: string) { bodyColor = c; write({ bodyColor: c }); }
  function setShape(v: Shape | '') {
    shape = v;
    write({ shape: v === '' ? undefined : v });
  }
  function setAccent(c: string) { accent = c; write({ accent: c }); }
  function setBorderColor(c: string) { borderColor = c; write({ borderColor: c }); }
  function setBorderStyle(v: BorderStyle) { borderStyle = v; write({ borderStyle: v }); }
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
  function setFontSizeBody(raw: string) {
    if (raw === '') { fontSizeBody = ''; write({ fontSizeBody: undefined }); return; }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { fontSizeBody = n; write({ fontSizeBody: n }); }
  }

  function restoreDefaults() {
    // Clear the style block entirely; the cascade resolves fresh values on
    // the next render. Local state is reset to defaults so the controls
    // visibly snap back during the popup's animation.
    backgroundColor = '';
    headerColor = '';
    bodyColor = '';
    shape = '';
    accent = '';
    borderColor = '';
    borderStyle = 'solid';
    borderWidth = 1;
    shadowIntensity = target.defaultShadow;
    dct = '';
    width = '';
    fontSizeTitle = '';
    fontSizeBody = '';
    target.write(boardId, elementId, null);
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
      // Push a single style command spanning every pick made during this
      // session. Read the live style from the cache (NOT local $state) so
      // the "after" snapshot holds exactly what's on screen: local state
      // mixes initial defaults with user edits.
      if (hasChanged) {
        const afterStyle = target.readLive(boardId, elementId);
        if (afterStyle && JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
          historyStore.pushWithoutExecute(target.command(boardId, elementId, beforeStyle, afterStyle));
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
  class="element-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px;"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="popup-header" onpointerdown={onDragStart} onpointermove={onDragMove} onpointerup={onDragEnd} onpointercancel={onDragEnd}>
    <span class="popup-title" id={popupTitleId}>{target.title}</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>Restore to Theme Defaults</button>

  <!-- A card splits into three colourable zones: Header (title bar /
       TileHeader), Body (text content), Background (outer shell where the
       footer chrome — priority pill, due-date, tag chips — sits). Empty
       fields fall through the cascade to board / global / theme defaults. -->
  <div class="style-row"><span>Header Colour</span><ColorPicker value={headerColor} onchange={setHeaderColor} anchorTo={popupEl} /></div>
  <div class="style-row"><span>Body Colour</span><ColorPicker value={bodyColor} onchange={setBodyColor} anchorTo={popupEl} /></div>
  {#if fields.backgroundColor}
    <div class="style-row"><span>Background</span><ColorPicker value={backgroundColor} onchange={setBackgroundColor} anchorTo={popupEl} /></div>
  {/if}

  {#if fields.shape}
    <!-- Outer card shape. 'Inherit' falls through to board / global defaults. -->
    <div class="style-row">
      <label for="{p}-shape">Shape</label>
      <select id="{p}-shape" value={shape} onchange={(e) => setShape((e.target as HTMLSelectElement).value as Shape | '')}>
        <option value="">Inherit</option>
        <option value="rounded">Rounded</option>
        <option value="rectangle">Rectangle</option>
      </select>
    </div>
  {/if}

  {#if fields.accent}
    <!-- Per-column accent — drives the header accent bar AND the
         card-count badge tint. Empty falls through to the board-level
         accent (`settings.accentColor`) and finally the theme default. -->
    <div class="style-row"><span>Accent</span><ColorPicker value={accent} onchange={setAccent} anchorTo={popupEl} /></div>
  {/if}

  <div class="style-row"><span>Border Colour</span><ColorPicker value={borderColor} onchange={setBorderColor} anchorTo={popupEl} /></div>

  <div class="style-row">
    <label for="{p}-border-style">Border Style</label>
    <select id="{p}-border-style" value={borderStyle} onchange={(e) => setBorderStyle((e.target as HTMLSelectElement).value as BorderStyle)}>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <div class="style-row">
    <label for="{p}-border-width">Border Width</label>
    <input id="{p}-border-width" class="style-number" type="number" min="0" max="10" value={borderWidth} onchange={(e) => setBorderWidth(parseInt((e.target as HTMLInputElement).value) || 0)} />
  </div>

  <div class="style-row">
    <label for="{p}-shadow">Shadow</label>
    <div class="range-with-readout">
      <input id="{p}-shadow" class="style-range" type="range" min="0" max="1" step="0.05" value={shadowIntensity} oninput={(e) => setShadowIntensity(parseFloat((e.target as HTMLInputElement).value))} />
      <span class="range-value">{Math.round(shadowIntensity * 100)}%</span>
    </div>
  </div>

  <div class="style-row">
    <label for="{p}-dct">Dynamic Contrast Text</label>
    <select id="{p}-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  {#if fields.width}
    <div class="style-row">
      <label for="{p}-width">Column Width (px)</label>
      <input id="{p}-width" class="style-number" type="number" min="120" max="2000" step="10" placeholder="—" value={width} onchange={(e) => setWidth((e.target as HTMLInputElement).value)} />
    </div>
  {/if}

  <div class="style-row">
    <label for="{p}-{target.titleFontIdSuffix}">Title Font Size</label>
    <input id="{p}-{target.titleFontIdSuffix}" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeTitle} onchange={(e) => setFontSizeTitle((e.target as HTMLInputElement).value)} />
  </div>

  {#if fields.fontSizeBody}
    <div class="style-row">
      <label for="{p}-font-body">Body Font Size</label>
      <input id="{p}-font-body" class="style-number" type="number" min="8" max="48" placeholder="—" value={fontSizeBody} onchange={(e) => setFontSizeBody((e.target as HTMLInputElement).value)} />
    </div>
  {/if}
</div>

<style>
  .element-style-popup {
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
    .element-style-popup { animation: none; }
  }
</style>
