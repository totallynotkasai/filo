<script lang="ts">
  import { PIN_ICON_PATH } from '../../constants/icons';

  interface Props {
    /** Rendered width and height in px. */
    size?: number;
    /** Filled while the toolbar is pinned, so the state reads without the colour. */
    filled?: boolean;
  }

  let { size = 20, filled = false }: Props = $props();
</script>

<!-- The pin glyph for the floating board toolbars. Decorative: the button
     carries the accessible name and aria-pressed. -->
<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PIN_ICON_PATH} />
</svg>
