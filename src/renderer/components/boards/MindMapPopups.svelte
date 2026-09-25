<script lang="ts">
  /**
   * MindMapPopups — owns all transient popup state (frame style, connection
   * style, tile style, tag editor) for MindMapBoard. Mounted outside the
   * canvas-transform so `position: fixed` is viewport-relative. Parent opens
   * popups via the imperative `open*` methods.
   */
  import FrameStylePopup from '../frames/FrameStylePopup.svelte';
  import ConnectionStylePopup from '../connections/ConnectionStylePopup.svelte';
  import TileStylePopup from '../tiles/TileStylePopup.svelte';
  import TagEditor from '../tags/TagEditor.svelte';
  import type { Connection, Frame, Tile } from '../../schema/index';

  let frameStylePopup = $state<{ frame: Frame; x: number; y: number } | null>(null);
  let connectionStylePopup = $state<{ connection: Connection; x: number; y: number } | null>(null);
  let tileStylePopup = $state<{ tile: Tile; tileIds?: string[]; x: number; y: number } | null>(null);
  let tagEditorPopup = $state<{ tileId?: string; tileIds?: string[]; x: number; y: number } | null>(null);

  export function openFrameStyle(frame: Frame, x: number, y: number): void {
    frameStylePopup = { frame, x, y };
  }
  export function openConnectionStyle(connection: Connection, x: number, y: number): void {
    connectionStylePopup = { connection, x, y };
  }
  /** `tileIds` styles several tiles at once; the popup is seeded from `tile`. */
  export function openTileStyle(tile: Tile, x: number, y: number, tileIds?: string[]): void {
    tileStylePopup = { tile, tileIds, x, y };
  }
  export function openTagEditor(args: {
    tileId?: string; tileIds?: string[]; x: number; y: number;
  }): void {
    tagEditorPopup = args;
  }
</script>

<!-- Frame style popup -->
{#if frameStylePopup}
  <FrameStylePopup
    frame={frameStylePopup.frame}
    x={frameStylePopup.x}
    y={frameStylePopup.y}
    onclose={() => frameStylePopup = null}
  />
{/if}

<!-- Connection style popup -->
{#if connectionStylePopup}
  <ConnectionStylePopup
    connection={connectionStylePopup.connection}
    x={connectionStylePopup.x}
    y={connectionStylePopup.y}
    onclose={() => connectionStylePopup = null}
  />
{/if}

<!-- Tile style popup (from context menu) -->
{#if tileStylePopup}
  <TileStylePopup
    tile={tileStylePopup.tile}
    tileIds={tileStylePopup.tileIds}
    x={tileStylePopup.x}
    y={tileStylePopup.y}
    onclose={() => tileStylePopup = null}
  />
{/if}

<!-- Tag editor popup (from context menu) -->
{#if tagEditorPopup}
  <div class="popup-overlay" style="position: fixed; left: {tagEditorPopup.x}px; top: {tagEditorPopup.y}px; z-index: var(--z-context-menu-overlay);">
    <TagEditor
      tileId={tagEditorPopup.tileId}
      tileIds={tagEditorPopup.tileIds}
      onClose={() => tagEditorPopup = null}
    />
  </div>
{/if}

