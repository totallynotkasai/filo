<script lang="ts">
  /**
   * Live Preview — shows a mock canvas tile, frame, kanban column/card,
   * task row, and document element rendered from the *pending* settings
   * copy. The tile previews route through `effectiveTileStyle` etc. so
   * they hit the same cascade as the real renderers, including Dynamic
   * Contrast Text.
   *
   * Used inside the Settings modal to give immediate visual feedback as
   * the user edits defaults — without persisting changes until Apply.
   */
  import type { ProjectSettings, Tile, Frame, Board, Connection } from '../../schema/index';
  import {
    effectiveTileStyle,
    effectiveFrameStyle,
    effectiveColumnStyle,
    effectiveCardStyle,
    effectiveTaskStyle,
    effectiveTaskSectionStyle,
    effectiveDocumentStyle,
    effectiveConnectionPathStyle,
    effectiveConnectionLabelStyle,
  } from '../../lib/styles/effectiveStyle';
  import { vaultStore } from '../../stores/vault.svelte';

  let {
    settings,
    board = null,
    boardSettings = null,
    activeTab = null,
  }: {
    settings: ProjectSettings | null;
    board?: Board | null;
    boardSettings?: Record<string, unknown> | null;
    /**
     * Drives the cascade caption. On the Global Defaults tab the user
     * needs to know that any Current Board override below will mask
     * what they're editing — otherwise the preview can look "broken"
     * when nothing visually changes.
     */
    activeTab?: 'defaults' | 'current-board' | null;
  } = $props();

  let cascadeHint = $derived.by(() => {
    if (activeTab === 'defaults') {
      return 'Showing: Global Defaults › Theme. Per-board overrides are hidden here so changes preview accurately.';
    }
    if (activeTab === 'current-board') {
      return 'Showing: per-element › Current Board › Global Defaults › Theme. Per-element overrides on existing tiles will still mask these board values.';
    }
    return null;
  });

  // Synthesise the cascade input for the preview.
  // - On Global Defaults tab: collapse to null so `boardLayer()` in
  //   effectiveStyle.ts contributes nothing and the preview shows
  //   *only* the global pending edits + theme defaults underneath.
  // - On Current Board tab: feed the pending board settings so the
  //   full cascade renders. Falls back to the live board if no pending
  //   session is active.
  let previewBoard = $derived<Board | null>(
    activeTab === 'defaults'
      ? null
      : board && boardSettings
        ? ({ ...board, settings: boardSettings } as Board)
        : board,
  );

  // Per-element style only carries the schema-required colour fields as
  // empty strings (which are interpreted as "unset" by the cascade — see
  // `effectiveTileStyle`). Hardcoding shape / borderStyle / borderWidth /
  // shadowIntensity here would short-circuit the cascade and the
  // BoardDefaults edits for those fields would have no visible effect
  // (P2.6).
  const mockTile: Tile = {
    id: 'preview-tile',
    type: 'text',
    title: 'Preview Tile',
    contentId: 'preview',
    content: '',
    boardId: 'preview',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    locked: false,
    faded: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    style: {
      headerColor: '',
      bodyColor: '',
      borderColor: '',
    },
  } as Tile;

  const mockFrame: Frame = {
    id: 'preview-frame',
    boardId: 'preview',
    title: 'Preview Frame',
    position: { x: 0, y: 0 },
    size: { width: 220, height: 110 },
    style: {
      backgroundImage: '',
      borderColor: '',
    },
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
  } as Frame;

  // A mock Connection with no per-element overrides so the cascade resolves
  // entirely from board / global defaults — same trick as `mockTile`.
  const mockConnection: Connection = {
    id: 'preview-connection',
    boardId: 'preview',
    fromTileId: 'a',
    toTileId: 'b',
    fromBubble: 3,
    toBubble: 7,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    label: {
      text: 'label',
      textColor: '',
      backgroundColor: '',
      position: 0.5,
      locked: false,
    },
    createdAt: 0,
    updatedAt: 0,
  } as Connection;

  let tileStyle = $derived(effectiveTileStyle(mockTile, settings, previewBoard));
  let frameStyle = $derived(effectiveFrameStyle(mockFrame, settings, previewBoard));
  let columnStyle = $derived(effectiveColumnStyle(null, settings, previewBoard));
  let cardStyle = $derived(effectiveCardStyle(null, settings, previewBoard));
  let taskStyle = $derived(effectiveTaskStyle(null, settings, previewBoard));
  let taskSectionStyle = $derived(effectiveTaskSectionStyle(null, settings, previewBoard));
  let documentStyle = $derived(effectiveDocumentStyle(settings, previewBoard));
  let connectionPathStyle = $derived(effectiveConnectionPathStyle(mockConnection, settings, previewBoard));
  let connectionLabelStyle = $derived(effectiveConnectionLabelStyle(null, settings, previewBoard));

  // Resolved data-URL preview for the Frame `backgroundImage` default. Mirrors
  // the loading pattern in CurrentBoardMindMap.svelte. Empty / external URLs
  // pass through; vault-relative paths are converted via the media IPC channel.
  let frameBgPreviewUrl = $state('');
  $effect(() => {
    const src = frameStyle.backgroundImage ?? '';
    const vaultPath = vaultStore.path;
    if (!src) { frameBgPreviewUrl = ''; return; }
    if (src.startsWith('http') || src.startsWith('data:')) {
      frameBgPreviewUrl = src;
      return;
    }
    if (!vaultPath) { frameBgPreviewUrl = ''; return; }
    let cancelled = false;
    void window.filo.invoke('media:read-file', vaultPath, src).then((res) => {
      if (cancelled) return;
      frameBgPreviewUrl = res.success
        ? `data:${res.mimeType};base64,${res.data}`
        : '';
    });
    return () => { cancelled = true; };
  });

  // Per-board-type background pattern + accent colour, resolved from the
  // pending settings the modal is editing. Falls back to project settings
  // for the live (un-edited) values; mirrors the cascade collapse on the
  // "Global Defaults" tab where previewBoard is null.
  function patternFor(type: 'mindmap' | 'kanban' | 'tasklist' | 'document'): 'grid' | 'dots' | 'lines' | 'none' {
    const fromSettings = settings?.[type] as { backgroundPattern?: 'grid' | 'dots' | 'lines' | 'none' } | undefined;
    return fromSettings?.backgroundPattern ?? 'grid';
  }
  function bgColorFor(type: 'mindmap' | 'kanban' | 'tasklist' | 'document'): string {
    const fromSettings = settings?.[type] as { backgroundColor?: string } | undefined;
    return fromSettings?.backgroundColor ?? '';
  }
  function accentFor(type: 'kanban' | 'tasklist' | 'document'): string {
    const fromSettings = settings?.[type] as { accentColor?: string } | undefined;
    return fromSettings?.accentColor ?? '';
  }
  let mindmapPattern = $derived(patternFor('mindmap'));
  let mindmapBg = $derived(bgColorFor('mindmap'));

  /**
   * Small inline SVG pattern swatch (~80×40). Mirrors BoardBackground's
   * pattern set without the full pan/zoom math — fixed background-size so
   * the dot/grid/lines stay visually consistent inside the swatch.
   */
  function patternSwatchStyle(pattern: 'grid' | 'dots' | 'lines' | 'none', bg: string): string {
    const fallbackBg = bg || 'var(--canvas-bg, var(--ui-bg))';
    const stroke = 'rgba(127, 127, 127, 0.7)';
    if (pattern === 'none') return `background: ${fallbackBg};`;
    let svg = '';
    if (pattern === 'grid') {
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><path d='M 12 0 L 0 0 0 12' fill='none' stroke='${stroke}' stroke-width='1'/></svg>`;
    } else if (pattern === 'dots') {
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><circle cx='6' cy='6' r='1.2' fill='${stroke}'/></svg>`;
    } else {
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><line x1='0' y1='12' x2='12' y2='12' stroke='${stroke}' stroke-width='1'/></svg>`;
    }
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    return `background-color: ${fallbackBg}; background-image: ${url}; background-size: 12px 12px;`;
  }

  // Connection path-as-SVG: builds an inline SVG fragment showing the
  // resolved colour / size / dash / arrow on a short horizontal segment.
  function dashArray(s: string, w: number): string {
    if (s === 'dashed') return `${w * 3} ${w * 2}`;
    if (s === 'dotted') return `${w} ${w * 2}`;
    return '';
  }
</script>

<section class="live-preview" aria-label="Live preview">
  <header class="preview-header">
    <h4 class="preview-title">Live Preview</h4>
    <span class="preview-hint">Reflects unsaved changes — not yet written to disk.</span>
  </header>

  {#if cascadeHint}
    <p class="preview-cascade-hint">{cascadeHint}</p>
  {/if}

  <div class="preview-grid">
    <!-- Tile -->
    <div class="preview-cell">
      <span class="preview-label">Tile</span>
      <div
        class="preview-tile"
        style="
          border-radius: {tileStyle.shape === 'rounded' ? '8px' : '2px'};
          border: {tileStyle.borderWidth}px {tileStyle.borderStyle} {tileStyle.borderColor || 'var(--tile-border)'};
          box-shadow: 0 2px {8 * tileStyle.shadowIntensity}px rgba(0,0,0,{tileStyle.shadowIntensity});
        "
      >
        <div
          class="preview-tile-header"
          style="background: {tileStyle.headerColor || 'var(--tile-header-bg)'}; color: {tileStyle.headerTextColor ?? 'var(--text-primary)'};{tileStyle.fontSizeTitle != null ? ` font-size: ${tileStyle.fontSizeTitle}px;` : ''}"
        >
          Title
        </div>
        <div
          class="preview-tile-body"
          style="background: {tileStyle.bodyColor || 'var(--tile-body-bg)'}; color: {tileStyle.bodyTextColor ?? 'var(--text-primary)'};{tileStyle.fontSizeBody != null ? ` font-size: ${tileStyle.fontSizeBody}px;` : ''}"
        >
          Body content here
        </div>
      </div>
    </div>

    <!-- Frame -->
    <div class="preview-cell">
      <span class="preview-label">Frame</span>
      <div
        class="preview-frame"
        style="
          background: {frameStyle.bodyColor || 'var(--ui-surface)'};
          border: {frameStyle.borderWidth}px {frameStyle.borderStyle} {frameStyle.borderColor || 'var(--ui-border)'};
          color: {frameStyle.bodyTextColor ?? 'var(--text-primary)'};
          box-shadow: 0 2px {8 * frameStyle.shadowIntensity}px rgba(0,0,0,{frameStyle.shadowIntensity});
        "
      >
        {#if frameBgPreviewUrl}
          <div
            class="preview-frame-bg"
            style="background-image: url('{frameBgPreviewUrl}'); opacity: {frameStyle.backgroundOpacity};"
          ></div>
        {/if}
        <div
          class="preview-frame-header"
          style="background: {frameStyle.headerColor || 'var(--ui-surface-raised)'}; color: {frameStyle.headerTextColor ?? 'var(--text-primary)'};{frameStyle.fontSizeTitle != null ? ` font-size: ${frameStyle.fontSizeTitle}px;` : ''}"
        >
          Frame title
        </div>
        <div class="preview-frame-body">Contents</div>
      </div>
    </div>

    <!-- Column -->
    <div class="preview-cell">
      <span class="preview-label">Kanban column</span>
      <div
        class="preview-column"
        style="
          background: {columnStyle.bodyColor || 'var(--ui-surface)'};
          border: {columnStyle.borderWidth}px {columnStyle.borderStyle} {columnStyle.borderColor || 'var(--ui-border-light)'};
          box-shadow: 0 2px {8 * columnStyle.shadowIntensity}px rgba(0,0,0,{0.3 * columnStyle.shadowIntensity});
          color: {columnStyle.bodyTextColor ?? 'var(--text-primary)'};
        "
      >
        <div
          class="preview-column-header"
          style="background: {columnStyle.headerColor || 'var(--ui-surface-raised)'}; color: {columnStyle.headerTextColor ?? 'var(--text-primary)'};{columnStyle.fontSizeTitle != null ? ` font-size: ${columnStyle.fontSizeTitle}px;` : ''}"
        >
          To Do
        </div>
        <div class="preview-column-body">2 cards</div>
      </div>
    </div>

    <!-- Card -->
    <div class="preview-cell">
      <span class="preview-label">Kanban card</span>
      <div
        class="preview-card"
        style="
          background: {cardStyle.backgroundColor || 'var(--ui-surface)'};
          border: {cardStyle.borderWidth}px {cardStyle.borderStyle} {cardStyle.borderColor || 'var(--ui-border-light)'};
          box-shadow: 0 2px {8 * cardStyle.shadowIntensity}px rgba(0,0,0,{0.3 * cardStyle.shadowIntensity});
          color: {cardStyle.textColor ?? 'var(--text-primary)'};
        "
      >
        <div style={cardStyle.fontSizeTitle != null ? `font-size: ${cardStyle.fontSizeTitle}px; font-weight: 600;` : 'font-weight: 600;'}>Card title</div>
        <div style={cardStyle.fontSizeBody != null ? `font-size: ${cardStyle.fontSizeBody}px;` : ''}>Body line</div>
      </div>
    </div>

    <!-- Task -->
    <div class="preview-cell">
      <span class="preview-label">Task</span>
      <div
        class="preview-task"
        style="
          background: {taskStyle.bodyColor || 'var(--ui-surface)'};
          border: {taskStyle.borderWidth}px {taskStyle.borderStyle} {taskStyle.borderColor || 'var(--ui-border-light)'};
          box-shadow: 0 2px {8 * taskStyle.shadowIntensity}px rgba(0,0,0,{0.3 * taskStyle.shadowIntensity});
          color: {taskStyle.bodyTextColor ?? 'var(--text-primary)'};
        "
      >
        <input type="checkbox" disabled />
        <div class="preview-task-text">
          <div style={taskStyle.fontSizeTitle != null ? `font-size: ${taskStyle.fontSizeTitle}px;` : ''}>Sample task item</div>
          <div class="preview-task-body" style={taskStyle.fontSizeBody != null ? `font-size: ${taskStyle.fontSizeBody}px;` : ''}>Body / notes</div>
        </div>
      </div>
    </div>

    <!-- Task Section (P2.9) -->
    <div class="preview-cell">
      <span class="preview-label">Task section</span>
      <div
        class="preview-section"
        style="
          background: {taskSectionStyle.bodyColor || 'var(--ui-surface)'};
          border: {taskSectionStyle.borderWidth}px {taskSectionStyle.borderStyle} {taskSectionStyle.borderColor || 'var(--ui-border-light)'};
          box-shadow: 0 2px {8 * taskSectionStyle.shadowIntensity}px rgba(0,0,0,{0.3 * taskSectionStyle.shadowIntensity});
          color: {taskSectionStyle.bodyTextColor ?? 'var(--text-primary)'};
        "
      >
        <div
          class="preview-section-header"
          style="background: {taskSectionStyle.headerColor || 'var(--ui-surface-raised)'}; color: {taskSectionStyle.headerTextColor ?? 'var(--text-primary)'};{taskSectionStyle.fontSizeTitle != null ? ` font-size: ${taskSectionStyle.fontSizeTitle}px;` : ''}"
        >
          Section heading
        </div>
        <div class="preview-section-body">2 tasks</div>
      </div>
    </div>

    <!-- Document Element (P2.10) -->
    <div class="preview-cell">
      <span class="preview-label">Document</span>
      <div
        class="preview-document"
        style="
          background: {documentStyle.bodyColor || 'var(--ui-surface)'};
          border: {documentStyle.borderWidth}px {documentStyle.borderStyle} {documentStyle.borderColor || 'var(--ui-border-light)'};
          box-shadow: 0 2px {8 * documentStyle.shadowIntensity}px rgba(0,0,0,{0.3 * documentStyle.shadowIntensity});
          color: {documentStyle.bodyTextColor ?? 'var(--text-primary)'};
        "
      >
        Document body
      </div>
    </div>

    <!-- Mind Map background + pattern (P2.7) -->
    <div class="preview-cell">
      <span class="preview-label">Mind Map background</span>
      <div class="preview-canvas-swatch" style={patternSwatchStyle(mindmapPattern, mindmapBg)}></div>
    </div>

    <!-- Connection path (P2.7) -->
    <div class="preview-cell">
      <span class="preview-label">Connection path</span>
      <div class="preview-conn-path">
        <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
          {#if connectionPathStyle.arrowType === 'start' || connectionPathStyle.arrowType === 'both'}
            <polygon points="0,20 {connectionPathStyle.arrowSize},{20 - connectionPathStyle.arrowSize / 2} {connectionPathStyle.arrowSize},{20 + connectionPathStyle.arrowSize / 2}" fill={connectionPathStyle.arrowColor || 'var(--connection-arrow-color)'} />
          {/if}
          <line
            x1={connectionPathStyle.arrowType === 'start' || connectionPathStyle.arrowType === 'both' ? connectionPathStyle.arrowSize : 0}
            y1="20"
            x2={connectionPathStyle.arrowType === 'end' || connectionPathStyle.arrowType === 'both' ? 120 - connectionPathStyle.arrowSize : 120}
            y2="20"
            stroke={connectionPathStyle.pathColor || 'var(--connection-path-color)'}
            stroke-width={connectionPathStyle.pathSize}
            stroke-dasharray={dashArray(connectionPathStyle.pathStyle, connectionPathStyle.pathSize)}
          />
          {#if connectionPathStyle.arrowType === 'end' || connectionPathStyle.arrowType === 'both'}
            <polygon points="120,20 {120 - connectionPathStyle.arrowSize},{20 - connectionPathStyle.arrowSize / 2} {120 - connectionPathStyle.arrowSize},{20 + connectionPathStyle.arrowSize / 2}" fill={connectionPathStyle.arrowColor || 'var(--connection-arrow-color)'} />
          {/if}
        </svg>
      </div>
    </div>

    <!-- Connection label (P2.8) -->
    <div class="preview-cell">
      <span class="preview-label">Connection label</span>
      <div class="preview-conn-label-row">
        <span
          class="preview-conn-label"
          style="
            background: {connectionLabelStyle.backgroundColor || 'var(--ui-surface-raised)'};
            color: {connectionLabelStyle.textColor || 'var(--text-primary)'};
            {connectionLabelStyle.fontSize != null ? `font-size: ${connectionLabelStyle.fontSize}px;` : ''}
          "
        >
          Sample label
        </span>
      </div>
    </div>

    <!-- Accent colours (P2.12) -->
    <div class="preview-cell">
      <span class="preview-label">Accent</span>
      <div class="preview-accent-row">
        <span class="accent-chip" title="Kanban accent" style="background: {accentFor('kanban') || 'var(--accent-primary)'};">K</span>
        <span class="accent-chip" title="Task List accent" style="background: {accentFor('tasklist') || 'var(--accent-primary)'};">T</span>
        <span class="accent-chip" title="Document accent" style="background: {accentFor('document') || 'var(--accent-primary)'};">D</span>
      </div>
    </div>
  </div>
</section>

<style>
  .live-preview {
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    padding: 12px;
    background: var(--ui-bg-secondary);
    margin-bottom: 12px;
  }

  .preview-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 10px;
  }

  .preview-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .preview-hint {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .preview-cascade-hint {
    margin: 0 0 10px;
    padding: 6px 10px;
    border-left: 3px solid var(--accent-primary-alpha);
    background: var(--ui-bg);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .preview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
  }

  .preview-cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .preview-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .preview-tile,
  .preview-frame,
  .preview-column,
  .preview-section {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 6px;
    font-size: 11px;
  }

  .preview-frame {
    position: relative;
  }

  .preview-frame-bg {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    pointer-events: none;
    z-index: 0;
  }

  .preview-frame > .preview-frame-header,
  .preview-frame > .preview-frame-body {
    position: relative;
    z-index: 1;
  }

  .preview-tile-header,
  .preview-frame-header,
  .preview-column-header,
  .preview-section-header {
    padding: 4px 8px;
    font-weight: 600;
  }

  .preview-tile-body,
  .preview-frame-body,
  .preview-column-body,
  .preview-section-body {
    padding: 6px 8px;
    flex: 1;
  }

  .preview-card,
  .preview-task,
  .preview-document {
    padding: 8px;
    border-radius: 6px;
    font-size: 11px;
  }

  .preview-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .preview-task {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .preview-task-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .preview-task-body {
    color: var(--text-tertiary);
  }

  .preview-canvas-swatch {
    height: 44px;
    border-radius: 6px;
    border: 1px solid var(--ui-border-light);
  }

  .preview-conn-path {
    height: 44px;
    border-radius: 6px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border-light);
    padding: 4px;
  }

  .preview-conn-path svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .preview-conn-label-row {
    height: 44px;
    border-radius: 6px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border-light);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
  }

  .preview-conn-label {
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 11px;
  }

  .preview-accent-row {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 44px;
    border-radius: 6px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border-light);
    padding: 4px 8px;
  }

  .accent-chip {
    display: inline-flex;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
  }
</style>
