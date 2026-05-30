<script lang="ts">
  /**
   * BoardBackground — viewport-sized layer that paints the board's
   * background pattern (grid / dots / lines / none).
   *
   * Mounts OUTSIDE the canvas transform. Pan/zoom are applied via
   * `background-position` and `background-size` so the pattern looks
   * correct at any zoom level without needing a giant DOM element.
   *
   * NOTE: CSS variables (var(--foo)) do NOT resolve inside SVG data URIs
   * because they are standalone documents. We resolve them via
   * getComputedStyle at runtime.
   */
  import { themeStore } from '../../stores/theme.svelte';

  interface Props {
    pattern?: 'grid' | 'dots' | 'lines' | 'none';
    color?: string;
    bgColor?: string;
    panX?: number;
    panY?: number;
    scale?: number;
  }

  // Phase 1.2a — pattern default is 'none', not 'grid'. Grid is only
  // sensible for canvas-based boards (Mind Map) and the Mind Map cascade
  // explicitly opts in. Defaulting to 'none' here prevents a stale
  // .filo/settings.json (one that pre-dates `kanban.backgroundPattern`)
  // from leaking grid onto Kanban / Task List / Document.
  let {
    pattern = 'none',
    color = '',
    bgColor = '',
    panX = 0,
    panY = 0,
    scale = 1,
  }: Props = $props();

  const GRID_SIZE = 40;

  // Resolved color values (CSS variables don't work inside SVG data URIs).
  // bgColor fallback rules:
  //   - explicit prop → use it verbatim (user override)
  //   - pattern !== 'none' → fall back to --canvas-bg so the pattern paints
  //     on a proper canvas surface (Mind Map's traditional look)
  //   - pattern === 'none' + no prop → 'transparent' so the parent board's
  //     own background shows through. Without this, non-canvas boards
  //     (Kanban / Task List / Document) — which now mount BoardBackground
  //     for per-board pattern + colour overrides — would flood the entire
  //     board area with --canvas-bg (dark navy in dark theme), which is
  //     wrong: those boards aren't a canvas and should inherit --ui-bg.
  let resolvedPatternColor = $state('#888');
  let resolvedBgColor = $state('transparent');

  // `void themeStore.active` registers the reactive dependency so this
  // re-runs when the user switches themes. We read it for its tracking
  // side-effect — the value itself isn't needed because the resolved
  // colours come from the freshly-applied CSS variables on :root.
  $effect(() => {
    void themeStore.active;
    const style = getComputedStyle(document.documentElement);
    resolvedPatternColor = color || style.getPropertyValue('--canvas-pattern').trim() || '#888';
    if (bgColor) {
      resolvedBgColor = bgColor;
    } else if (pattern === 'none') {
      resolvedBgColor = 'transparent';
    } else {
      resolvedBgColor =
        style.getPropertyValue('--canvas-bg').trim()
        || style.getPropertyValue('--ui-bg').trim()
        || 'transparent';
    }
  });

  /**
   * Builds the SVG data URI for the chosen pattern. The SVG itself uses a
   * fixed GRID_SIZE — we scale via CSS background-size, which keeps the
   * stroke/dot at a fixed pixel weight as the user zooms.
   */
  function patternImage(p: typeof pattern, pc: string): string {
    switch (p) {
      case 'grid': {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_SIZE}" height="${GRID_SIZE}" aria-hidden="true"><path d="M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}" fill="none" stroke="${pc}" stroke-width="1"/></svg>`;
        return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
      }
      case 'dots': {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_SIZE}" height="${GRID_SIZE}" aria-hidden="true"><circle cx="${GRID_SIZE / 2}" cy="${GRID_SIZE / 2}" r="1.5" fill="${pc}"/></svg>`;
        return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
      }
      case 'lines': {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_SIZE}" height="${GRID_SIZE}" aria-hidden="true"><line x1="0" y1="${GRID_SIZE}" x2="${GRID_SIZE}" y2="${GRID_SIZE}" stroke="${pc}" stroke-width="1"/></svg>`;
        return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
      }
      case 'none':
      default:
        return 'none';
    }
  }

  let bgImage = $derived(patternImage(pattern, resolvedPatternColor));

  // Tile size in screen pixels = GRID_SIZE * scale. background-position is
  // taken modulo the tile size so the pattern tiles seamlessly under any
  // pan / zoom.
  let tileSize = $derived(Math.max(1, GRID_SIZE * scale));
  let posX = $derived(((panX % tileSize) + tileSize) % tileSize);
  let posY = $derived(((panY % tileSize) + tileSize) % tileSize);

  let style = $derived(
    pattern === 'none'
      ? `background-color: ${resolvedBgColor};`
      : `background-color: ${resolvedBgColor}; background-image: ${bgImage}; background-size: ${tileSize}px ${tileSize}px; background-position: ${posX}px ${posY}px;`,
  );
</script>

<div class="board-background" style={style}></div>

<style>
  .board-background {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
  }
</style>
