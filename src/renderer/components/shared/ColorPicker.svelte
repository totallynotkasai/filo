<script lang="ts">
  import { untrack } from 'svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import {
    rgbToHex,
    isValidHex,
    rgbToHsl,
    hslToRgb,
    parseCssColor,
    formatCssColor,
    type HSL,
  } from '../../lib/utils/color';

  interface Props {
    value: string;
    onchange: (color: string) => void;
    label?: string;
    allowAuto?: boolean;
    /** If true, shows the color panel directly without the swatch trigger button.
     *  Use this when the parent already has a trigger (e.g. toolbar color button). */
    expanded?: boolean;
    /** When provided, the popup panel is positioned to the right of this
     *  element (the parent style popup) and clicks inside the anchor are
     *  treated as "inside" by the outside-click handler. Falls back to the
     *  default below-the-swatch placement when omitted. */
    anchorTo?: HTMLElement | null;
    /** The swatch button's id, so a `<label for>` can name it. */
    id?: string;
    /** What the swatch is announced as (default: the label, else "Pick color"). */
    ariaLabel?: string;
    /**
     * Always show the Opacity slider. Without it the slider shows only while
     * the value is translucent, so a picked colour keeps the value's alpha.
     */
    showAlpha?: boolean;
  }

  let {
    value,
    onchange,
    label = '',
    allowAuto = true,
    expanded = false,
    anchorTo = null,
    id = undefined,
    ariaLabel = undefined,
    showAlpha = false,
  }: Props = $props();

  // untrack: capture only the initial value
  let showPicker = $state(untrack(() => expanded));
  let pickerRef = $state<HTMLDivElement | null>(null);
  let swatchRef = $state<HTMLButtonElement | null>(null);
  let panelRef = $state<HTMLDivElement | null>(null);
  let wheelCanvas = $state<HTMLCanvasElement | null>(null);
  // Initialised once; the `value` $effect below keeps it in sync after that.
  let hexInputValue = $state(untrack(() => value));

  // Popup-mode panel placement, recomputed when the picker opens or the
  // window resizes. Using `position: fixed` lets the panel escape the
  // Settings modal's `overflow: hidden`/`overflow: auto` clipping.
  const PANEL_WIDTH = 280;
  // Approximate panel height — we don't measure because the panel may not
  // be in the DOM yet when we first compute the position. Used only for
  // viewport-edge clamping in anchored mode.
  const PANEL_HEIGHT_HINT = 460;
  const PANEL_GAP = 8;
  let panelPos = $state<{ top: number; left: number }>({ top: 0, left: 0 });

  function updatePanelPos() {
    // Anchored mode: place the panel to the right of the parent popup,
    // vertically aligned with the swatch row. Falls back to the left side
    // if the right would overflow the viewport.
    if (anchorTo) {
      const anchorRect = anchorTo.getBoundingClientRect();
      const swatchRect = swatchRef?.getBoundingClientRect();
      const rightSpace = window.innerWidth - anchorRect.right - PANEL_GAP - 8;
      const fitsRight = rightSpace >= PANEL_WIDTH;
      const left = fitsRight
        ? anchorRect.right + PANEL_GAP
        : Math.max(8, anchorRect.left - PANEL_WIDTH - PANEL_GAP);
      // Vertically align to the swatch when available, otherwise to the
      // top of the anchor. Clamp inside the viewport.
      const desiredTop = swatchRect ? swatchRect.top : anchorRect.top;
      const top = Math.max(
        8,
        Math.min(desiredTop, window.innerHeight - PANEL_HEIGHT_HINT - 8),
      );
      panelPos = { top, left };
      return;
    }
    if (!swatchRef) return;
    const rect = swatchRef.getBoundingClientRect();
    let left = rect.left;
    // Keep the panel inside the viewport horizontally.
    if (left + PANEL_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
    }
    panelPos = { top: rect.bottom + PANEL_GAP, left };
  }

  // Portal the popup panel to the nearest <dialog> ancestor (so it sits in
  // the dialog's top-layer) or to document.body as a fallback. Restores
  // its original position on destroy. Pass `enabled=false` to skip
  // portaling for the inline `expanded` mode.
  function panelPortal(node: HTMLElement, enabled: boolean) {
    if (!enabled) return {};
    const target = (pickerRef?.closest('dialog') as HTMLElement | null) ?? document.body;
    const origParent = node.parentElement;
    const origNext = node.nextSibling;
    if (target !== origParent) target.appendChild(node);
    return {
      destroy() {
        if (origParent && node.parentElement === target) {
          if (origNext && origNext.parentElement === origParent) {
            origParent.insertBefore(node, origNext);
          } else {
            origParent.appendChild(node);
          }
        }
      },
    };
  }

  let isEmpty = $derived(value === '');
  let parsedValue = $derived(parseCssColor(value));
  let nativeValue = $derived(parsedValue ? rgbToHex(parsedValue) : '#888888');

  // Whether the platform exposes the EyeDropper API. Chromium-based
  // browsers (which Electron uses) implement it; jsdom in tests does not.
  let hasEyeDropper = $derived(
    typeof window !== 'undefined' && 'EyeDropper' in window,
  );

  const presets = [
    '#d32f2f', '#e91e63', '#9c27b0', '#673ab7',
    '#3f51b5', '#1a73e8', '#0288d1', '#00acc1',
    '#00897b', '#43a047', '#7cb342', '#c0ca33',
    '#fdd835', '#ffb300', '#fb8c00', '#f4511e',
    '#6d4c41', '#757575', '#546e7a', '#ffffff',
    '#e0e0e0', '#9e9e9e', '#424242', '#000000',
  ];

  const WHEEL_SIZE = 200;
  const WHEEL_RADIUS = WHEEL_SIZE / 2;

  // Live HSL representation. The wheel manipulates h/s; the brightness
  // slider manipulates l. We always keep all three so Auto/Hex updates
  // can rehydrate the wheel cleanly.
  let hsl = $state<HSL>({ h: 0, s: 1, l: 0.5 });
  /** The value's opacity (0–1). Every colour picked here keeps it. */
  let alpha = $state(1);
  let alphaShown = $derived(showAlpha || alpha < 1);

  // Whenever the external value changes (Auto, preset, hex commit),
  // re-derive the HSL state and opacity. Skip when the value is empty (Auto).
  $effect(() => {
    if (value === '') {
      hexInputValue = '';
      return;
    }
    const parsed = parseCssColor(value);
    hexInputValue = parsed ? rgbToHex(parsed) : value;
    if (!parsed) return;
    hsl = rgbToHsl(parsed);
    alpha = parsed.a;
  });

  // Repaint the HS wheel whenever the canvas mounts OR brightness changes.
  $effect(() => {
    if (!showPicker || !wheelCanvas) return;
    const ctx = wheelCanvas.getContext('2d');
    if (!ctx) return;
    drawWheel(ctx, hsl.l);
  });

  /**
   * Paints a polar HSL plot at the current lightness. Hue maps to angle,
   * saturation to radius. Pixels outside the disc remain transparent.
   */
  function drawWheel(ctx: CanvasRenderingContext2D, lightness: number) {
    const img = ctx.createImageData(WHEEL_SIZE, WHEEL_SIZE);
    const data = img.data;
    for (let y = 0; y < WHEEL_SIZE; y++) {
      for (let x = 0; x < WHEEL_SIZE; x++) {
        const dx = x - WHEEL_RADIUS;
        const dy = y - WHEEL_RADIUS;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * WHEEL_SIZE + x) * 4;
        if (dist > WHEEL_RADIUS) continue;
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        const h = (angle + 360) % 360;
        const s = Math.min(1, dist / WHEEL_RADIUS);
        const rgb = hslToRgb({ h, s, l: lightness });
        data[idx] = rgb.r;
        data[idx + 1] = rgb.g;
        data[idx + 2] = rgb.b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Position of the crosshair on the HS wheel, derived from current hsl. */
  let crosshair = $derived.by(() => {
    const angle = (hsl.h * Math.PI) / 180;
    const r = hsl.s * WHEEL_RADIUS;
    return {
      x: WHEEL_RADIUS + Math.cos(angle) * r,
      y: WHEEL_RADIUS + Math.sin(angle) * r,
    };
  });

  function handleWheelPointer(e: PointerEvent) {
    if (!wheelCanvas) return;
    const rect = wheelCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - WHEEL_RADIUS;
    const dy = y - WHEEL_RADIUS;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > WHEEL_RADIUS) return; // outside disc
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    const h = (angle + 360) % 360;
    const s = Math.min(1, dist / WHEEL_RADIUS);
    hsl = { ...hsl, h, s };
    commit(rgbToHex(hslToRgb(hsl)));
  }

  function handleWheelDrag(e: PointerEvent) {
    if (e.buttons !== 1) return;
    handleWheelPointer(e);
  }

  function handleBrightness(e: Event) {
    const t = e.target as HTMLInputElement;
    const l = parseFloat(t.value);
    if (Number.isNaN(l)) return;
    hsl = { ...hsl, l };
    commit(rgbToHex(hslToRgb(hsl)));
  }

  function commitHexInput() {
    const trimmed = hexInputValue.trim();
    if (!trimmed) {
      if (allowAuto) commit('');
      else hexInputValue = value;
      return;
    }
    if (!isValidHex(trimmed)) {
      // Revert the input to the last known good value
      hexInputValue = value;
      return;
    }
    // Expand #abc → #aabbcc to keep storage canonical.
    commit(trimmed.length === 4 ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}` : trimmed.toLowerCase());
  }

  async function pickWithEyeDropper() {
    if (!window.EyeDropper) return;
    try {
      const dropper = new window.EyeDropper();
      const result = await dropper.open();
      if (result?.sRGBHex && isValidHex(result.sRGBHex)) {
        commit(result.sRGBHex.toLowerCase());
      }
    } catch {
      /* user cancelled */
    }
  }

  function selectColor(color: string) {
    commit(color);
    if (!expanded) showPicker = false;
  }

  /**
   * An opaque colour picked while the value is translucent takes the value's
   * opacity, so picking a hue for a tint or a backdrop doesn't make it solid.
   * A colour that carries its own alpha (a recent rgba pick) keeps it.
   */
  function withAlpha(color: string): string {
    if (alpha >= 1) return color;
    const parsed = parseCssColor(color);
    if (!parsed || parsed.a < 1) return color;
    return formatCssColor({ ...parsed, a: alpha });
  }

  function commit(color: string) {
    const next = color === '' ? '' : withAlpha(color);
    onchange(next);
    if (next !== '') pushRecent(next);
  }

  function handleAlpha(e: Event) {
    const a = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isNaN(a)) return;
    alpha = a;
    const rgb = parsedValue ?? hslToRgb(hsl);
    onchange(formatCssColor({ r: rgb.r, g: rgb.g, b: rgb.b, a }));
  }

  /**
   * Prepends a colour to the recent-colours list, dedupes, and caps at 8.
   * Persisted via `vaultStore.markMetaDirty` → `.filo/app.json`.
   */
  function pushRecent(color: string) {
    const normalized = color.toLowerCase();
    const project = vaultStore.project;
    if (!project) return;
    const current = project.settings.general.recentColors ?? [];
    const next = [normalized, ...current.filter((c) => c.toLowerCase() !== normalized)].slice(0, 8);
    project.settings.general.recentColors = next;
    vaultStore.markMetaDirty();
  }

  let recentColors = $derived(
    (vaultStore.project?.settings.general.recentColors ?? []).slice(0, 8),
  );

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Node;
    // The panel is portaled outside `pickerRef`, so we have to check it
    // separately or every click inside the panel would close it.
    const insideWrapper = pickerRef?.contains(target) ?? false;
    const insidePanel = panelRef?.contains(target) ?? false;
    // In anchored mode (style popups), clicks elsewhere inside the parent
    // popup must not close the picker — otherwise toggling other controls
    // (or interacting with the popup chrome) would dismiss it.
    const insideAnchor = anchorTo?.contains(target) ?? false;
    if (!insideWrapper && !insidePanel && !insideAnchor) {
      closePicker();
    }
  }

  function closePicker() {
    if (!showPicker) return;
    showPicker = false;
    swatchRef?.focus();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
    }
  }

  // Click-outside is only relevant when the picker is acting as a popup.
  $effect(() => {
    if (showPicker && !expanded) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });

  // Reposition the popup whenever it opens or the viewport resizes.
  $effect(() => {
    if (!showPicker || expanded) return;
    updatePanelPos();
    const onResize = () => updatePanelPos();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

<div class="color-picker-wrapper" bind:this={pickerRef} data-keeps-editor-focus="true">
  {#if label}
    <span class="color-label">{label}</span>
  {/if}

  {#if !expanded}
    <button
      bind:this={swatchRef}
      class="color-swatch"
      class:auto-swatch={isEmpty}
      style="background: {isEmpty ? '' : value};"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => showPicker = !showPicker}
      title={isEmpty ? 'Auto (Theme)' : value}
      {id}
      aria-label={ariaLabel ?? (label || 'Pick color')}
    >
      {#if isEmpty}
        <span class="auto-indicator">A</span>
      {/if}
    </button>
  {/if}

  {#if showPicker}
    <div
      bind:this={panelRef}
      class="color-panel"
      class:static-panel={expanded}
      class:floating-panel={!expanded}
      role={expanded ? undefined : 'group'}
      aria-label={expanded ? undefined : 'Color picker'}
      tabindex="-1"
      onkeydown={expanded ? undefined : handleKeydown}
      style={expanded ? '' : `top: ${panelPos.top}px; left: ${panelPos.left}px; z-index: var(--z-dropdown);`}
      use:panelPortal={!expanded}
      data-keeps-editor-focus="true"
    >
      {#if allowAuto}
        <button
          class="auto-btn"
          class:active={isEmpty}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => selectColor('')}
        >
          Auto (Theme)
        </button>
      {/if}

      {#if recentColors.length > 0}
        <div class="picker-section-label">Recent</div>
        <div class="color-recent">
          {#each recentColors as color (color)}
            <button
              class="preset-swatch"
              class:active={value.toLowerCase() === color.toLowerCase()}
              style="background: {color};"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => selectColor(color)}
              title={color}
              aria-label={color}
            ></button>
          {/each}
        </div>
      {/if}

      <div class="picker-section-label">Presets</div>
      <div class="color-presets">
        {#each presets as color (color)}
          <button
            class="preset-swatch"
            class:active={value === color}
            style="background: {color};"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => selectColor(color)}
            title={color}
            aria-label={color}
          ></button>
        {/each}
      </div>

      <div class="picker-section-label">Custom</div>
      <div class="wheel-row">
        <div class="wheel-stack">
          <canvas
            bind:this={wheelCanvas}
            width={WHEEL_SIZE}
            height={WHEEL_SIZE}
            class="hsl-wheel"
            onpointerdown={handleWheelPointer}
            onpointermove={handleWheelDrag}
          ></canvas>
          <div
            class="wheel-crosshair"
            style="left: {crosshair.x}px; top: {crosshair.y}px;"
          ></div>
        </div>

        <div class="brightness-stack">
          <span class="brightness-label">Brightness</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={hsl.l}
            oninput={handleBrightness}
            class="brightness-slider"
            aria-label="Brightness"
          />
        </div>
      </div>

      {#if alphaShown}
        <div class="alpha-row">
          <span class="brightness-label" aria-hidden="true">Opacity</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={alpha}
            oninput={handleAlpha}
            class="alpha-slider"
            aria-label="Opacity"
          />
          <span class="alpha-value">{Math.round(alpha * 100)}%</span>
        </div>
      {/if}

      <div class="color-custom">
        <input
          type="color"
          value={nativeValue}
          oninput={(e) => commit((e.target as HTMLInputElement).value)}
          class="native-picker"
          aria-label="Native colour picker"
        />
        <input
          type="text"
          bind:value={hexInputValue}
          class="hex-input"
          placeholder="#rrggbb"
          onblur={commitHexInput}
          onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          maxlength="7"
        />
        {#if hasEyeDropper}
          <button
            class="eyedropper-btn"
            onclick={pickWithEyeDropper}
            title="Pick colour from screen"
            aria-label="Pick colour from screen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 22l1-1h3l9-9"/>
              <path d="M3 21l3 0"/>
              <path d="M14 12l4 4"/>
              <path d="M19.5 6.5l-1-1a2.121 2.121 0 0 0-3 0L13 8a2.121 2.121 0 0 0 0 3l1.5 1.5L20.5 7l-1-1z"/>
            </svg>
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .color-picker-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .color-label {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
  }

  .color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: 2px solid var(--ui-border);
    cursor: pointer;
    transition: border-color 0.1s ease;
  }

  .color-swatch:hover {
    border-color: var(--ui-border-focus);
  }

  .auto-swatch {
    background: repeating-conic-gradient(
      var(--ui-border) 0% 25%, var(--ui-surface) 0% 50%
    ) 50% / 10px 10px !important;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .auto-indicator {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-secondary);
    text-shadow: 0 0 2px var(--ui-surface);
  }

  .color-panel {
    /* z-index set inline from var(--z-dropdown) (above style popups). */
    padding: 12px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.15s ease;
    width: 280px;
  }

  /* Floating popup: portaled to the nearest <dialog> (or body) and
     positioned via top/left set inline from getBoundingClientRect.
     Using `position: fixed` lets it escape the modal's overflow. */
  .color-panel.floating-panel {
    position: fixed;
  }

  .color-panel.static-panel {
    position: static;
    box-shadow: none;
    border: none;
    padding: 0;
    animation: none;
    border-radius: 0;
    width: auto;
  }

  .picker-section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-tertiary);
    margin-top: 8px;
    margin-bottom: 4px;
  }

  .auto-btn {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-secondary);
    font-size: 11px;
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .auto-btn:hover {
    background: var(--ui-surface-hover);
    border-color: var(--ui-border-focus);
  }

  .auto-btn.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    background: var(--ui-surface-hover);
  }

  .color-recent,
  .color-presets {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 4px;
  }

  .preset-swatch {
    width: 24px;
    height: 24px;
    border-radius: 3px;
    border: 2px solid transparent;
    cursor: pointer;
    transition: border-color 0.1s ease, transform 0.1s ease;
  }

  .preset-swatch:hover {
    transform: scale(1.15);
  }

  .preset-swatch.active {
    border-color: var(--text-primary);
  }

  .wheel-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
  }

  .wheel-stack {
    position: relative;
    width: 200px;
    height: 200px;
    flex-shrink: 0;
  }

  .hsl-wheel {
    width: 200px;
    height: 200px;
    border-radius: 50%;
    cursor: crosshair;
    touch-action: none;
    background: var(--ui-bg);
  }

  .wheel-crosshair {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 1px 4px rgba(0, 0, 0, 0.4);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .brightness-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 200px;
    gap: 8px;
  }

  .brightness-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .brightness-slider {
    appearance: none;
    writing-mode: vertical-lr;
    direction: rtl;
    width: 6px;
    height: 180px;
    border-radius: 3px;
    background: linear-gradient(
      to top,
      #000 0%,
      #808080 50%,
      #fff 100%
    );
    cursor: pointer;
  }

  .brightness-slider::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    cursor: pointer;
  }

  .brightness-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    border: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    cursor: pointer;
  }

  .alpha-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .alpha-slider {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent-primary);
    cursor: pointer;
  }

  .alpha-value {
    width: 3.2em;
    text-align: right;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }

  .color-custom {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 8px;
    margin-top: 4px;
    border-top: 1px solid var(--ui-border);
  }

  .native-picker {
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
  }

  .native-picker::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .native-picker::-webkit-color-swatch {
    border: 1px solid var(--ui-border);
    border-radius: 4px;
  }

  .hex-input {
    flex: 1;
    min-width: 80px;
    padding: 4px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .hex-input::placeholder {
    color: var(--text-tertiary);
  }

  .eyedropper-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .eyedropper-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    border-color: var(--ui-border-focus);
  }
</style>
