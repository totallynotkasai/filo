<script lang="ts">
  /**
   * ConnectionStylePopup — style popup for editing connection path + label
   * appearance. Path/arrow colour, path type, path style, arrow type;
   * Label text colour, background colour, and font size.
   *
   * Mirrors the patterns from `TileStylePopup` (draggable header) and
   * `FrameStylePopup` (snapshot state via `untrack`). The snapshot
   * pattern is critical here: a previous `$derived(boardStore.connections[id])`
   * subscription combined with ColorPicker `onchange` writing back into
   * the store created an unbounded reactive cascade that froze the UI
   * after a single colour pick.
   *
   * Portaled to document.body via `use:portal` for parity with the
   * other style popups; this also defends against future ancestor
   * `transform` rules turning `position: fixed` into a container-
   * relative box. Dismissal is via Escape or the close button only
   * (matches TileStylePopup); a previous outside-click listener was
   * removed because unrelated UI clicks (e.g. toggling the minimap)
   * closed the popup unexpectedly.
   *
   * Colour pickers pop out to the right of the popup via
   * `anchorTo={popupEl}` and ignore clicks inside the popup itself.
   */
  import { untrack, getContext } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { createId } from '../../lib/utils/ids';
  import type { Connection } from '../../schema/index';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateConnectionCommand } from '../../commands/index';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { portal } from '../../lib/utils/portal';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';

  const popupTitleId = `conn-style-popup-title-${createId()}`;

  let {
    connection,
    x,
    y,
    onclose,
  }: {
    connection: Connection;
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  // Snapshot the editable Connection fields at mount so popup-close can
  // dispatch a single UpdateConnectionCommand spanning every pick made
  // during this session. Mirrors TileStylePopup pattern — pick the
  // subset the popup edits (path*, arrow*, label.*) so the command's
  // before/after diff is focused. JSON round-trip detaches from the
  // live $state Proxy.
  function snapshotConnFields(c: Connection): Partial<Connection> {
    return JSON.parse(JSON.stringify({
      pathColor: c.pathColor,
      arrowColor: c.arrowColor,
      pathSize: c.pathSize,
      arrowSize: c.arrowSize,
      pathType: c.pathType,
      pathStyle: c.pathStyle,
      arrowType: c.arrowType,
      label: c.label,
    }));
  }
  const beforeConn: Partial<Connection> = untrack(() => snapshotConnFields(connection));
  let hasChanged = false;

  // Snapshot the editable fields once on mount. Bindings read from
  // these local pieces of state — NOT from the store — so the popup
  // doesn't re-render in response to its own writes.
  let pathColor = $state(untrack(() => connection.pathColor ?? ''));
  let arrowColor = $state(untrack(() => connection.arrowColor ?? ''));
  let pathSize = $state<number | ''>(
    untrack(() => (typeof connection.pathSize === 'number' ? connection.pathSize : '')),
  );
  let arrowSize = $state<number | ''>(
    untrack(() => (typeof connection.arrowSize === 'number' ? connection.arrowSize : '')),
  );
  let pathType = $state<Connection['pathType']>(untrack(() => connection.pathType));
  let pathStyle = $state<Connection['pathStyle']>(untrack(() => connection.pathStyle));
  let arrowType = $state<Connection['arrowType']>(untrack(() => connection.arrowType));
  let labelTextColor = $state(untrack(() => connection.label.textColor ?? ''));
  let labelBackgroundColor = $state(untrack(() => connection.label.backgroundColor ?? ''));
  let labelFontSize = $state<number | ''>(
    untrack(() => connection.label.fontSize ?? ''),
  );

  // ── Drag state (mirrors TileStylePopup) ──
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

  function handlePathColorChange(color: string) {
    pathColor = color;
    boardStore.updateConnection(connection.id, { pathColor: color });
    hasChanged = true;
  }

  function handleArrowColorChange(color: string) {
    arrowColor = color;
    boardStore.updateConnection(connection.id, { arrowColor: color });
    hasChanged = true;
  }

  function handlePathSizeChange(size: number) {
    pathSize = size;
    boardStore.updateConnection(connection.id, { pathSize: size });
    hasChanged = true;
  }

  function handleArrowSizeChange(size: number) {
    arrowSize = size;
    boardStore.updateConnection(connection.id, { arrowSize: size });
    hasChanged = true;
  }

  function selectPathType(type: Connection['pathType'] | '') {
    pathType = type === '' ? undefined : type;
    boardStore.updateConnection(connection.id, { pathType: pathType });
    hasChanged = true;
  }

  function selectPathStyle(style: Connection['pathStyle'] | '') {
    pathStyle = style === '' ? undefined : style;
    boardStore.updateConnection(connection.id, { pathStyle: pathStyle });
    hasChanged = true;
  }

  function selectArrowType(type: Connection['arrowType'] | '') {
    arrowType = type === '' ? undefined : type;
    boardStore.updateConnection(connection.id, { arrowType: arrowType });
    hasChanged = true;
  }

  // Merge against the latest connection in the store (not the mount-time
  // prop snapshot) so concurrent edits to `label.text`, `label.position`,
  // `label.locked` from other surfaces are preserved when the user picks
  // a colour or font size in this popup.
  function writeLabel(patch: Partial<Connection['label']>) {
    const current = boardStore.connections[connection.id];
    if (!current) return;
    boardStore.updateConnection(connection.id, {
      label: { ...current.label, ...patch },
    });
    hasChanged = true;
  }

  function handleLabelTextColorChange(color: string) {
    labelTextColor = color;
    writeLabel({ textColor: color });
  }

  function handleLabelBackgroundColorChange(color: string) {
    labelBackgroundColor = color;
    writeLabel({ backgroundColor: color });
  }

  function handleLabelFontSizeChange(raw: string) {
    if (raw === '') {
      labelFontSize = '';
      writeLabel({ fontSize: undefined });
      return;
    }
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    labelFontSize = v;
    writeLabel({ fontSize: v });
  }

  /**
   * Clear every per-connection override so the cascade resolves fresh
   * values from board / global defaults. Empty strings for colour
   * fields (which `effectiveConnectionPathStyle` treats as unset) and
   * undefined for the enum / numeric fields (now optional in
   * ConnectionSchema — see schema docstring). Future global-default
   * changes propagate without baking copies into this connection.
   */
  function restoreToDefaults() {
    pathColor = '';
    arrowColor = '';
    pathSize = '';
    arrowSize = '';
    pathType = undefined;
    pathStyle = undefined;
    arrowType = undefined;
    labelTextColor = '';
    labelBackgroundColor = '';
    labelFontSize = '';
    boardStore.updateConnection(connection.id, {
      pathColor: '',
      arrowColor: '',
      pathSize: undefined,
      arrowSize: undefined,
      pathType: undefined,
      pathStyle: undefined,
      arrowType: undefined,
      label: {
        ...connection.label,
        textColor: '',
        backgroundColor: '',
        fontSize: undefined,
      },
    });
    hasChanged = true;
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
    // Capture board id at popup mount so the deferred command
    // push lands on the originating board even if the user switched
    // boards while the popup was open.
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
      // Push a single UpdateConnectionCommand spanning every pick made
      // during this session. Read the live connection from the store
      // so the "after" snapshot reflects exactly what's on screen.
      // Mirrors the TileStylePopup pattern; pushWithoutExecute since the
      // live preview has already mutated the store.
      if (hasChanged) {
        const current = boardStore.connections[connection.id];
        if (current) {
          const afterConn = snapshotConnFields(current);
          if (JSON.stringify(beforeConn) !== JSON.stringify(afterConn)) {
            historyStore.pushWithoutExecute(
              new UpdateConnectionCommand(connection.id, beforeConn, afterConn, mountBoardId),
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
  class="conn-style-popup"
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
    <span class="popup-title" id={popupTitleId}>Connection Style</span>
    <button class="close-btn" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <button class="restore-defaults-btn" onclick={restoreToDefaults}>Restore to Theme Defaults</button>

  <!-- Path Color -->
  <div class="style-row">
    <span>Path Colour</span>
    <ColorPicker value={pathColor} onchange={handlePathColorChange} anchorTo={popupEl} />
  </div>

  <!-- Path Size -->
  <div class="style-row">
    <label for="conn-path-size">Path Size</label>
    <div class="size-controls">
      <input
        id="conn-path-size"
        type="range"
        min="1"
        max="10"
        step="1"
        value={pathSize === '' ? 2 : pathSize}
        oninput={(e) => handlePathSizeChange(parseInt((e.target as HTMLInputElement).value, 10))}
      />
      <span class="size-value">{pathSize === '' ? 2 : pathSize}px</span>
    </div>
  </div>

  <!-- Arrow Color -->
  <div class="style-row">
    <span>Arrow Colour</span>
    <ColorPicker value={arrowColor} onchange={handleArrowColorChange} anchorTo={popupEl} />
  </div>

  <!-- Arrow Size -->
  <div class="style-row">
    <label for="conn-arrow-size">Arrow Size</label>
    <div class="size-controls">
      <input
        id="conn-arrow-size"
        type="range"
        min="4"
        max="24"
        step="1"
        value={arrowSize === '' ? 10 : arrowSize}
        oninput={(e) => handleArrowSizeChange(parseInt((e.target as HTMLInputElement).value, 10))}
      />
      <span class="size-value">{arrowSize === '' ? 10 : arrowSize}px</span>
    </div>
  </div>

  <!-- Path Type -->
  <div class="style-row">
    <label for="conn-path-type">Path Type</label>
    <select id="conn-path-type" value={pathType ?? ''} onchange={(e) => selectPathType((e.target as HTMLSelectElement).value as Connection['pathType'] | '')}>
      <option value="">Inherit</option>
      <option value="curved">Curved</option>
      <option value="straight">Straight</option>
      <option value="elbow">Elbow</option>
      <option value="smart">Smart</option>
    </select>
  </div>

  <!-- Path Style -->
  <div class="style-row">
    <label for="conn-path-style">Path Style</label>
    <select id="conn-path-style" value={pathStyle ?? ''} onchange={(e) => selectPathStyle((e.target as HTMLSelectElement).value as Connection['pathStyle'] | '')}>
      <option value="">Inherit</option>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  </div>

  <!-- Arrow Type -->
  <div class="style-row">
    <label for="conn-arrow-type">Arrows</label>
    <select id="conn-arrow-type" value={arrowType ?? ''} onchange={(e) => selectArrowType((e.target as HTMLSelectElement).value as Connection['arrowType'] | '')}>
      <option value="">Inherit</option>
      <option value="none">None</option>
      <option value="start">Start</option>
      <option value="end">End</option>
      <option value="both">Both</option>
    </select>
  </div>

  <div class="style-section-divider">Label</div>

  <!-- Text Colour -->
  <div class="style-row">
    <span>Text Colour</span>
    <ColorPicker value={labelTextColor} onchange={handleLabelTextColorChange} anchorTo={popupEl} />
  </div>

  <!-- Background Colour -->
  <div class="style-row">
    <span>Background Colour</span>
    <ColorPicker value={labelBackgroundColor} onchange={handleLabelBackgroundColorChange} anchorTo={popupEl} />
  </div>

  <!-- Font Size -->
  <div class="style-row">
    <label for="conn-label-font-size">Font Size</label>
    <input
      id="conn-label-font-size"
      class="style-number"
      type="number"
      min="8"
      max="32"
      placeholder="—"
      value={labelFontSize}
      onchange={(e) => handleLabelFontSizeChange((e.target as HTMLInputElement).value)}
    />
  </div>
</div>

<style>
  .conn-style-popup {
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

  .size-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .size-controls input[type="range"] {
    width: 90px;
    accent-color: var(--accent-primary);
    cursor: pointer;
  }

  .size-value {
    font-size: 11px;
    color: var(--text-tertiary);
    min-width: 32px;
    text-align: right;
  }

  .style-section-divider {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-top: 6px;
    margin-top: 2px;
    border-top: 1px solid var(--ui-border-light);
  }

  @media (prefers-reduced-motion: reduce) {
    .conn-style-popup {
      animation: none;
    }
  }
</style>
