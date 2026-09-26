<script lang="ts">
  import { STYLE_ICON_PATH } from '../../constants/icons';

  interface Props {
    /** Rendered width and height in px. */
    size?: number;
  }

  let { size = 14 }: Props = $props();
</script>

<!-- The Style glyph (a palette) for every Style button. Decorative:
     the button carries the accessible name. -->
<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={STYLE_ICON_PATH} />
</svg>
