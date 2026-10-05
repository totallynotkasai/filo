<script lang="ts">
  /**
   * FrameStylePopup — style popup for editing frame appearance.
   * Background colour/image/opacity, border colour/style/width.
   *
   * Mirrors the patterns from `ConnectionStylePopup`: snapshot props via
   * `untrack`, draggable header, Escape/X close (no outside-click backdrop —
   * unrelated UI clicks would dismiss it unexpectedly). The colour pickers
   * pop out to the right of the popup via `anchorTo={popupEl}`, and treat
   * clicks inside the popup as "inside" so other controls don't dismiss them.
   */
  import type { Frame } from '../../schema/index';
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { createId } from '../../lib/utils/ids';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateFrameStyleCommand } from '../../commands/index';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import ColorPicker from '../shared/ColorPicker.svelte';
  import BackgroundImagePicker from '../shared/BackgroundImagePicker.svelte';
  import { getActiveContentFolder } from '../../lib/vault/conventionPaths';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const popupTitleId = `frame-style-popup-title-${createId()}`;

  let {
    frame,
    x,
    y,
    onclose,
  }: {
    frame: Frame;
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Snapshot the whole style block at mount so popup-close can dispatch a
  // single UpdateFrameStyleCommand spanning every pick made during this
  // session. JSON round-trip detaches the snapshot from the live $state
  // Proxy so later store mutations don't leak in.
  const beforeStyle: Frame['style'] = untrack(() =>
    JSON.parse(JSON.stringify(frame.style ?? {})),
  );
  let hasChanged = false;

  // Snapshot the cascade-readable per-element fields. Falling back to `''`
  // (not a literal default colour) lets the colour pickers show "Auto" and
  // the cascade resolve a board/global override at render time.
  let headerColor = $state(untrack(() => frame.style.headerColor ?? ''));
  let bodyColor = $state(untrack(() => frame.style.bodyColor ?? ''));
  let bgImage = $state(untrack(() => frame.style.backgroundImage ?? ''));
  let bgOpacity = $state<number | ''>(
    untrack(() => (typeof frame.style.backgroundOpacity === 'number' ? frame.style.backgroundOpacity : '')),
  );
  let borderColor = $state(untrack(() => frame.style.borderColor ?? ''));
  let borderStyle = $state<'solid' | 'dashed' | 'dotted' | undefined>(
    untrack(() => frame.style.borderStyle),
  );
  let borderWidth = $state<number | ''>(
    untrack(() => (typeof frame.style.borderWidth === 'number' ? frame.style.borderWidth : '')),
  );
  let shape = $state<'rectangle' | 'rounded' | ''>(
    untrack(() => (frame.style.shape ?? '')),
  );
  let shadowIntensity = $state<number | ''>(
    untrack(() => (typeof frame.style.shadowIntensity === 'number' ? frame.style.shadowIntensity : '')),
  );
  let dct = $state<'' | 'true' | 'false'>(
    untrack(() => (
      frame.style.dynamicContrastText === true
        ? 'true'
        : frame.style.dynamicContrastText === false
          ? 'false'
          : ''
    )),
  );
  let fontSizeTitle = $state<number | ''>(
    untrack(() => (typeof frame.style.fontSizeTitle === 'number' ? frame.style.fontSizeTitle : '')),
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

  // Patch-merge against the latest frame.style from the store (not the
  // mount-time prop snapshot) so concurrent edits — and any `.passthrough()`
  // fields a future Filo version or third-party tool wrote into
  // `frame.style` — are preserved when the user changes a single field.
  function dispatchStyle(patch: Partial<Frame['style']>): void {
    const current = boardStore.frames.find((f) => f.id === frame.id);
    if (!current) return;
    boardStore.updateFrame(frame.id, {
      style: { ...current.style, ...patch },
    });
    hasChanged = true;
  }

  function setDct(value: '' | 'true' | 'false') {
    dct = value;
    dispatchStyle({ dynamicContrastText: value === '' ? undefined : value === 'true' });
  }

  /**
   * Clear every per-element override so the cascade resolves fresh values
   * from board / global defaults. Local popup state is cleared so the
   * controls fall through to whatever the cascade resolves on the next
   * render — future global-default changes propagate without baking
   * copies into the frame. Works because FrameStyleSchema's cascade-
   * participating fields (borderStyle / borderWidth / backgroundOpacity /
   * shadowIntensity / headerColor / bodyColor) are all optional.
   */
  function restoreDefaults() {
    headerColor = '';
    bodyColor = '';
    bgImage = '';
    bgOpacity = '';
    borderColor = '';
    borderStyle = undefined;
    borderWidth = '';
    shape = '';
    shadowIntensity = '';
    dct = '';
    fontSizeTitle = '';
    boardStore.updateFrame(frame.id, { style: {} as never });
    hasChanged = true;
  }

  function handleHeaderColorChange(color: string) {
    headerColor = color;
    dispatchStyle({ headerColor: color });
  }

  function handleBodyColorChange(color: string) {
    bodyColor = color;
    dispatchStyle({ bodyColor: color });
  }

  function handleBorderColorChange(color: string) {
    borderColor = color;
    dispatchStyle({ borderColor: color });
  }

  function onBgImageChange(value: string) {
    bgImage = value;
    dispatchStyle({ backgroundImage: value });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); }
  }

  // Focus restoration: capture the trigger element so keyboard users return
  // there on popup close (mirrors Modal.svelte + ContextMenu).
  // Focus trap keeps Tab cycling inside the popup once it has focus.
  let trap: FocusTrap | null = null;
  $effect(() => {
    const triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Capture board id at popup mount so the deferred push lands
    // on the originating board even if the user switched boards in the
    // meantime.
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
      // Push a single UpdateFrameStyleCommand for the whole session — only
      // if the user actually changed something, and only if before/after
      // differ. The store mutations have already happened (live preview),
      // so pushWithoutExecute records the diff for undo/redo without
      // re-running the writes. Mirrors the TileStylePopup pattern.
      if (hasChanged) {
        const current = boardStore.frames.find((f) => f.id === frame.id);
        if (current) {
          const afterStyle: Frame['style'] = JSON.parse(JSON.stringify(current.style ?? {}));
          if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
            historyStore.pushWithoutExecute(
              new UpdateFrameStyleCommand(frame.id, beforeStyle, afterStyle, mountBoardId),
            );
          }
        }
      }
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  use:portal
  class="frame-style-popup"
  bind:this={popupEl}
  role="group"
  aria-labelledby={popupTitleId}
  tabindex="-1"
  style="left: {hasBeenDragged ? popupPos.x : x}px; top: {hasBeenDragged ? popupPos.y : y}px"
  onclick={(e) => e.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="popup-header"
    onpointerdown={onDragStart}
    onpointermove={onDragMove}
    onpointerup={onDragEnd}
    onpointercancel={onDragEnd}
  >
    <span class="popup-title" id={popupTitleId}>Frame Style</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreDefaults}>
    Restore to Theme Defaults
  </button>

  <!-- Header Colour -->
  <div class="style-row">
    <span>Header Colour</span>
    <ColorPicker value={headerColor} onchange={handleHeaderColorChange} anchorTo={popupEl} />
  </div>

  <!-- Body Colour -->
  <div class="style-row">
    <span>Body Colour</span>
    <ColorPicker value={bodyColor} onchange={handleBodyColorChange} anchorTo={popupEl} />
  </div>

  <!-- Background Image (Upload) -->
  <div class="style-row bg-image-row">
    <span>Background Image</span>
    <BackgroundImagePicker value={bgImage} onChange={onBgImageChange} folder={getActiveContentFolder(boardStore.current)} />
  </div>

  <!-- Frame Opacity — applies to header fill + body fill + background image
       together. Border, title text and buttons stay fully opaque so the
       frame remains findable at low opacity. -->
  <div class="style-row">
    <label for="frame-opacity">Frame Opacity</label>
    <input
      id="frame-opacity"
      class="style-range"
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={bgOpacity === '' ? 1 : bgOpacity}
      oninput={(e) => { bgOpacity = parseFloat((e.target as HTMLInputElement).value); dispatchStyle({ backgroundOpacity: bgOpacity }); }}
    />
    <span class="range-value">{Math.round((bgOpacity === '' ? 1 : bgOpacity) * 100)}%</span>
  </div>

  <!-- Shape — mirrors the tile vocabulary so frames pick from the same set
       (Rectangle / Rounded). 'Inherit' falls through to board / global. -->
  <div class="style-row">
    <label for="frame-shape">Shape</label>
    <select
      id="frame-shape"
      value={shape}
      onchange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        shape = v === '' ? '' : (v as 'rectangle' | 'rounded');
        dispatchStyle({ shape: shape === '' ? undefined : shape });
      }}
    >
      <option value="">Inherit</option>
      <option value="rounded">Rounded</option>
      <option value="rectangle">Rectangle</option>
    </select>
  </div>

  <!-- Border Colour -->
  <div class="style-row">
    <span>Border Colour</span>
    <ColorPicker value={borderColor} onchange={handleBorderColorChange} anchorTo={popupEl} />
  </div>

  <!-- Border Style -->
  <div class="style-row">
    <label for="frame-border-style">Border Style</label>
    <select
      id="frame-border-style"
      value={borderStyle ?? ''}
      onchange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        borderStyle = v === '' ? undefined : (v as 'solid' | 'dashed' | 'dotted');
        dispatchStyle({ borderStyle });
      }}
    >
      <option value="">Inherit</option>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <!-- Border Width -->
  <div class="style-row">
    <label for="frame-border-width">Border Width</label>
    <input
      id="frame-border-width"
      class="style-number"
      type="number"
      min="0"
      max="10"
      placeholder="—"
      value={borderWidth}
      onchange={(e) => {
        const raw = (e.target as HTMLInputElement).value;
        if (raw === '') { borderWidth = ''; dispatchStyle({ borderWidth: undefined }); return; }
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 10) { borderWidth = n; dispatchStyle({ borderWidth: n }); }
      }}
    />
  </div>

  <!-- Shadow Intensity -->
  <div class="style-row">
    <label for="frame-shadow">Shadow</label>
    <input
      id="frame-shadow"
      class="style-range"
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={shadowIntensity === '' ? 0.3 : shadowIntensity}
      oninput={(e) => { shadowIntensity = parseFloat((e.target as HTMLInputElement).value); dispatchStyle({ shadowIntensity }); }}
    />
    <span class="range-value">{Math.round((shadowIntensity === '' ? 0.3 : shadowIntensity) * 100)}%</span>
  </div>

  <!-- Dynamic Contrast Text -->
  <div class="style-row">
    <label for="frame-dct">Dynamic Contrast Text</label>
    <select id="frame-dct" value={dct} onchange={(e) => setDct((e.target as HTMLSelectElement).value as '' | 'true' | 'false')}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <!-- Title Font Size -->
  <div class="style-row">
    <label for="frame-fs-title">Title Font Size</label>
    <input
      id="frame-fs-title"
      class="style-number"
      type="number"
      min="8"
      max="48"
      placeholder="—"
      value={fontSizeTitle}
      onchange={(e) => {
        const raw = (e.target as HTMLInputElement).value;
        if (raw === '') { fontSizeTitle = ''; dispatchStyle({ fontSizeTitle: undefined }); return; }
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 8 && n <= 48) { fontSizeTitle = n; dispatchStyle({ fontSizeTitle: n }); }
      }}
    />
  </div>
</div>

<style>
  .frame-style-popup {
    position: fixed;
    z-index: var(--z-context-menu-overlay);
    min-width: 240px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    padding: 12px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.15s ease;
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
    min-width: 70px;
  }

  .style-row select {
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    color: var(--text-primary);
    flex: 1;
  }

  .style-number {
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    color: var(--text-primary);
    width: 60px;
  }

  .style-range {
    flex: 1;
    accent-color: var(--accent-primary);
  }

  .range-value {
    font-size: 11px;
    color: var(--text-tertiary);
    min-width: 32px;
    text-align: right;
  }

  .bg-image-row {
    align-items: center;
  }

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

  .restore-defaults-btn:hover {
    background: var(--ui-surface-raised);
    border-color: var(--accent-primary);
  }

  @media (prefers-reduced-motion: reduce) {
    .frame-style-popup {
      animation: none;
    }
  }
</style>
