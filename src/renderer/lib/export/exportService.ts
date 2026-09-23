import { toPng, toSvg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { boardStore } from '../../stores/board.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { canvasStore } from '../../stores/canvas.svelte';
import type {
  Project,
  Tile,
  Board,
  MindMapBoard,
  KanbanBoard,
  TaskListBoard,
  DocumentBoard,
} from '../../schema/index';
import { stripLeadingSlash, toPosix } from '../utils/path';

/**
 * Export utilities for exporting the current board or project
 * to PNG, SVG, PDF, Markdown, or single-file HTML formats.
 */

/** Reads the current canvas background color from the theme's CSS custom property. */
function getCanvasBg(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#1a1a2e';
}

/**
 * Captures the board workspace element as a PNG data URL.
 */
export async function exportToPng(element: HTMLElement): Promise<string> {
  const dataUrl = await toPng(element, {
    backgroundColor: getCanvasBg(),
    pixelRatio: 2,
    filter: (node) => {
      // Exclude UI overlays like minimap, toolbar, etc.
      if (node instanceof HTMLElement) {
        const cl = node.classList;
        if (cl.contains('minimap') || cl.contains('side-toolbar')) return false;
      }
      return true;
    },
  });
  return dataUrl;
}

/**
 * Captures the board workspace element as an SVG string.
 */
export async function exportToSvg(element: HTMLElement): Promise<string> {
  const svgString = await toSvg(element, {
    backgroundColor: getCanvasBg(),
    filter: (node) => {
      if (node instanceof HTMLElement) {
        const cl = node.classList;
        if (cl.contains('minimap') || cl.contains('side-toolbar')) return false;
      }
      return true;
    },
  });
  return svgString;
}

/**
 * Captures the board workspace element as a PDF.
 * Returns a base64-encoded PDF string.
 */
export async function exportToPdf(element: HTMLElement): Promise<string> {
  const dataUrl = await toPng(element, {
    backgroundColor: getCanvasBg(),
    pixelRatio: 2,
    filter: (node) => {
      if (node instanceof HTMLElement) {
        const cl = node.classList;
        if (cl.contains('minimap') || cl.contains('side-toolbar')) return false;
      }
      return true;
    },
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  const pxToMm = 0.264583;
  const width = img.width * pxToMm;
  const height = img.height * pxToMm;

  const pdf = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [width, height],
  });

  pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
  const pdfBase64 = pdf.output('datauristring').split(',')[1] ?? '';
  return pdfBase64;
}

/**
 * Serializes a project to Markdown format.
 */
export function exportToMarkdown(project: Project): string {
  const lines: string[] = [];

  lines.push(`# ${project.name || 'Untitled Project'}`);
  lines.push('');
  lines.push(`> Exported from Filo on ${new Date().toLocaleDateString()}`);
  lines.push('');

  for (const board of project.boards) {
    lines.push(`## ${board.name} (${formatBoardType(board.type)})`);
    lines.push('');

    const boardTiles = Object.values(boardStore.getFullTilesForBoard(board.id));

    for (const tile of boardTiles) {
      lines.push(`### ${tile.title}`);
      lines.push('');
      lines.push(serializeTileContent(tile));
      lines.push('');

      if (tile.tags && tile.tags.length > 0) {
        const tagNames = tile.tags.filter(Boolean).map((name) => `\`${name}\``);
        if (tagNames.length) {
          lines.push(`Tags: ${tagNames.join(', ')}`);
          lines.push('');
        }
      }
    }
  }

  return lines.join('\n');
}

function formatBoardType(type: string): string {
  const map: Record<string, string> = {
    mindmap: 'Mind Map',
    kanban: 'Kanban Board',
    tasklist: 'Task List',
    document: 'Document',
  };
  return map[type] || type;
}

function serializeTileContent(tile: Tile): string {
  switch (tile.type) {
    case 'text':
      // Strip HTML tags for plain markdown
      return stripHtml(tile.content || '');
    case 'image':
      return tile.src ? `![${tile.title}](${tile.src})` : '*No image*';
    case 'video':
      return tile.src ? `[Video: ${tile.title}](${tile.src})` : '*No video*';
    case 'audio':
      return tile.src ? `[Audio: ${tile.title}](${tile.src})` : '*No audio*';
    case 'file':
      return tile.filePath ? `[File: ${tile.fileName || tile.title}](${tile.filePath})` : '*No file*';
    case 'link':
      return tile.url ? `[${tile.title}](${tile.url})` : '*No link*';
    case 'iframe':
      return tile.url ? `[Embed: ${tile.title}](${tile.url})` : '*No embed*';
    case 'timer':
      return `Timer: ${tile.title}`;
    default:
      return '';
  }
}

function stripHtml(html: string): string {
  // Basic HTML to Markdown conversion
  let text = html;
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
  text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
  text = text.replace(/<u[^>]*>(.*?)<\/u>/gi, '$1');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&nbsp;/g, ' ');
  return text.trim();
}

// ── HTML export ──

/**
 * Serializes a project to a self-contained, read-only HTML document with
 * inline CSS. Mind Map boards preserve canvas positions; Kanban / Task List /
 * Document boards render in their native layouts. Media tiles keep their
 * `filo://` URLs — the file opens correctly inside Filo and gracefully
 * degrades (alt text, broken-image icons) when viewed in a plain browser.
 */
export function exportToHtml(project: Project): string {
  const title = escapeHtml(project.name || 'Untitled Project');
  const exportedAt = escapeHtml(new Date().toLocaleString());

  const boardSections = project.boards.map(renderBoardSection).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${EXPORT_HTML_CSS}
</style>
</head>
<body>
<header class="project-header">
  <h1>${title}</h1>
  <p class="meta">Exported from Filo on ${exportedAt}</p>
</header>
<main>
${boardSections}
</main>
</body>
</html>`;
}

const EXPORT_HTML_CSS = `
:root {
  --fg: #1a1a2e;
  --fg-muted: #5a5a6e;
  --bg: #f6f6fa;
  --surface: #ffffff;
  --border: #d8d8e0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.5;
}
.project-header {
  padding: 32px 40px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.project-header h1 { margin: 0 0 4px; font-size: 28px; }
.project-header .meta { margin: 0; color: var(--fg-muted); font-size: 13px; }
main { padding: 24px 40px 48px; }
.board { margin-bottom: 48px; }
.board-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.board-header h2 { margin: 0; font-size: 22px; }
.board-header .board-type {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
.canvas {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: auto;
}
.tile {
  position: absolute;
  background: var(--surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tile-header {
  padding: 6px 10px;
  font-weight: 600;
  font-size: 13px;
}
.tile-body {
  padding: 8px 10px;
  flex: 1;
  font-size: 13px;
  overflow: hidden;
}
.tile-body img,
.tile-body video,
.tile-body iframe { max-width: 100%; max-height: 100%; display: block; }
.tile-body p:first-child { margin-top: 0; }
.tile-body p:last-child { margin-bottom: 0; }
.kanban-board {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
}
.kanban-column {
  flex: 0 0 280px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}
.kanban-column h3 {
  margin: 0 0 12px;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
}
.kanban-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  margin-bottom: 8px;
  font-size: 13px;
}
.kanban-card .card-title { font-weight: 600; margin-bottom: 4px; }
.kanban-card img.cover {
  width: calc(100% + 20px);
  margin: -10px -10px 8px;
  display: block;
  max-height: 120px;
  object-fit: cover;
}
.tasklist {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
}
.task {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.task:last-child { border-bottom: none; }
.task-title { font-weight: 600; }
.task-body { font-size: 13px; color: var(--fg-muted); margin-top: 4px; }
.document {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 24px 32px;
  max-width: 760px;
}
.document img { max-width: 100%; height: auto; }
.tags { margin-top: 6px; font-size: 11px; color: var(--fg-muted); }
.tag { display: inline-block; padding: 1px 6px; margin-right: 4px; border-radius: 999px; background: rgba(0,0,0,0.05); }
.empty { color: var(--fg-muted); font-style: italic; }
`;

function renderBoardSection(board: Board): string {
  const name = escapeHtml(board.name || 'Untitled Board');
  const typeLabel = escapeHtml(formatBoardType(board.type));
  let body: string;
  switch (board.type) {
    case 'mindmap':
      body = renderMindMap(board);
      break;
    case 'kanban':
      body = renderKanban(board);
      break;
    case 'tasklist':
      body = renderTaskList(board);
      break;
    case 'document':
      body = renderDocument(board);
      break;
    default:
      body = '';
  }
  return `<section class="board board-${escapeAttr(board.type)}">
  <div class="board-header"><h2>${name}</h2><span class="board-type">${typeLabel}</span></div>
  ${body}
</section>`;
}

function renderMindMap(board: MindMapBoard): string {
  const tiles = Object.values(boardCacheStore.getFullTilesForBoard(board.id));
  if (tiles.length === 0) return '<p class="empty">Empty board.</p>';

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    minX = Math.min(minX, tile.position.x);
    minY = Math.min(minY, tile.position.y);
    maxX = Math.max(maxX, tile.position.x + tile.size.width);
    maxY = Math.max(maxY, tile.position.y + tile.size.height);
  }
  const padding = 40;
  const width = Math.ceil(maxX - minX + padding * 2);
  const height = Math.ceil(maxY - minY + padding * 2);

  const tileHtml = tiles
    .map((tile) => renderCanvasTile(tile, minX - padding, minY - padding))
    .join('\n');

  return `<div class="canvas" style="width:${width}px;height:${height}px;">
${tileHtml}
</div>`;
}

function renderCanvasTile(tile: Tile, offsetX: number, offsetY: number): string {
  const left = Math.round(tile.position.x - offsetX);
  const top = Math.round(tile.position.y - offsetY);
  const width = Math.round(tile.size.width);
  const height = Math.round(tile.size.height);

  const style = tile.style;
  const radius = style.shape === 'rounded' ? 8 : 0;
  const shadow =
    style.shadowIntensity > 0
      ? `box-shadow: 0 ${Math.round(style.shadowIntensity * 12)}px ${Math.round(style.shadowIntensity * 24)}px rgba(0,0,0,${(style.shadowIntensity * 0.4).toFixed(2)});`
      : '';

  const tileStyle = [
    `left:${left}px`,
    `top:${top}px`,
    `width:${width}px`,
    `height:${height}px`,
    `background:${escapeAttr(style.bodyColor || '#ffffff')}`,
    `border:${style.borderWidth || 1}px ${style.borderStyle || 'solid'} ${escapeAttr(style.borderColor || '#d8d8e0')}`,
    `border-radius:${radius}px`,
    shadow,
  ]
    .filter(Boolean)
    .join(';');

  const headerStyle = `background:${escapeAttr(style.headerColor || 'transparent')}`;
  const header = `<div class="tile-header" style="${headerStyle}">${renderTitle(tile)}</div>`;
  const body = `<div class="tile-body">${renderTileBody(tile)}</div>`;
  const tags = renderTags(tile.tags);

  return `<div class="tile tile-${escapeAttr(tile.type)}" style="${tileStyle}">${header}${body}${tags}</div>`;
}

function renderKanban(board: KanbanBoard): string {
  const tiles = boardCacheStore.getFullTilesForKanbanBoard(board.id);
  const columns = (board.columns ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  if (columns.length === 0) return '<p class="empty">No columns.</p>';

  const columnHtml = columns
    .map((col) => {
      const title = escapeHtml(col.title || 'Untitled');
      const placements = (col.tilePlacements ?? [])
        .slice()
        .sort((a, b) => a.position - b.position);
      const cards = placements
        .map((p) => {
          const tile = tiles[p.tileId];
          if (!tile) return '';
          const cover = p.coverImage
            ? `<img class="cover" src="${escapeAttr(toExportMediaUrl(p.coverImage))}" alt="">`
            : '';
          const cardTitle = `<div class="card-title">${renderTitle(tile)}</div>`;
          const body = renderTileBody(tile);
          const bodyEl = body ? `<div class="card-body">${body}</div>` : '';
          const tags = renderTags(tile.tags);
          return `<div class="kanban-card">${cover}${cardTitle}${bodyEl}${tags}</div>`;
        })
        .join('\n');
      return `<div class="kanban-column">
  <h3>${title}</h3>
  ${cards || '<p class="empty">Empty.</p>'}
</div>`;
    })
    .join('\n');

  return `<div class="kanban-board">${columnHtml}</div>`;
}

function renderTaskList(board: TaskListBoard): string {
  const tiles = boardCacheStore.getFullTasksForBoard(board.id);
  const tasks = (board.tasks ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  if (tasks.length === 0) return '<p class="empty">No tasks.</p>';

  const taskHtml = tasks
    .map((p) => {
      const tile = tiles[p.tileId];
      if (!tile) return '';
      const title = `<div class="task-title">${renderTitle(tile)}</div>`;
      const body = renderTileBody(tile);
      const bodyEl = body ? `<div class="task-body">${body}</div>` : '';
      const tags = renderTags(tile.tags);
      return `<div class="task">${title}${bodyEl}${tags}</div>`;
    })
    .join('\n');

  return `<div class="tasklist">${taskHtml}</div>`;
}

function renderDocument(board: DocumentBoard): string {
  const content = board.content || '';
  if (!content.trim()) return '<p class="empty">Empty document.</p>';
  return `<div class="document">${content}</div>`;
}

function renderTitle(tile: Tile): string {
  if (tile.titleHtml && tile.titleHtml.trim()) return tile.titleHtml;
  return escapeHtml(tile.title || '');
}

function renderTileBody(tile: Tile): string {
  switch (tile.type) {
    case 'text':
      return tile.content || '';
    case 'image': {
      if (!tile.src) return '<span class="empty">No image</span>';
      const alt = escapeAttr(tile.alt || tile.title || '');
      return `<img src="${escapeAttr(toExportMediaUrl(tile.src))}" alt="${alt}">`;
    }
    case 'video':
      return tile.src
        ? `<video controls src="${escapeAttr(toExportMediaUrl(tile.src))}"></video>`
        : '<span class="empty">No video</span>';
    case 'audio':
      return tile.src
        ? `<audio controls src="${escapeAttr(toExportMediaUrl(tile.src))}"></audio>`
        : '<span class="empty">No audio</span>';
    case 'file': {
      if (!tile.filePath) return '<span class="empty">No file</span>';
      const label = escapeHtml(tile.fileName || tile.title || 'File');
      return `<a href="${escapeAttr(toExportMediaUrl(tile.filePath))}">${label}</a>`;
    }
    case 'link':
      return tile.url
        ? `<a href="${escapeAttr(tile.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tile.url)}</a>`
        : '<span class="empty">No link</span>';
    case 'iframe':
      return tile.url
        ? `<a href="${escapeAttr(tile.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tile.url)}</a>`
        : '<span class="empty">No embed</span>';
    case 'timer':
      return `<span>Timer (${escapeHtml(tile.mode)})</span>`;
    default:
      return '';
  }
}

function renderTags(tags: readonly string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  const items = tags
    .filter(Boolean)
    .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
    .join('');
  return items ? `<div class="tags">${items}</div>` : '';
}

/**
 * Build a media URL for inclusion in the exported HTML. Local vault paths are
 * wrapped in `filo://media/...` (matching the renderer's runtime URLs). When
 * the HTML file is opened outside Filo those URLs won't resolve — accepted
 * trade-off for keeping the export a single text file with no asset bundle.
 */
function toExportMediaUrl(src: string): string {
  if (!src) return '';
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:') ||
    src.startsWith('filo://') ||
    src.startsWith('mailto:')
  ) {
    return src;
  }
  const normalised = stripLeadingSlash(toPosix(src));
  const encoded = normalised.split('/').map(encodeURIComponent).join('/');
  return `filo://media/${encoded}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Triggers an export flow: captures the element, then saves via IPC.
 */
export async function doExport(
  format: 'png' | 'svg' | 'pdf' | 'md' | 'html',
  element: HTMLElement | null,
  project: Project | null,
  projectName?: string,
): Promise<{ success: boolean; error?: string; canceled?: boolean }> {
  try {
    const name = projectName || project?.name || 'export';

    if (format === 'md') {
      if (!project) return { success: false, error: 'No project to export' };
      const markdown = exportToMarkdown(project);
      const result = await window.filo.invoke('export:save', 'md', markdown, name);
      return result;
    }

    if (format === 'html') {
      if (!project) return { success: false, error: 'No project to export' };
      const html = exportToHtml(project);
      const result = await window.filo.invoke('export:save', 'html', html, name);
      return result;
    }

    if (!element) return { success: false, error: 'No board element to capture' };

    let data: string;

    // Disable viewport culling so the export includes every tile, not just
    // those on-screen. Wait one animation frame for the DOM to render the
    // newly-mounted tiles before capturing.
    canvasStore.setExportMode(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      if (format === 'png') {
        const dataUrl = await exportToPng(element);
        data = dataUrl.split(',')[1] ?? ''; // Strip data:image/png;base64, prefix
      } else if (format === 'svg') {
        data = await exportToSvg(element);
        // SVG comes as a data URL, extract the SVG
        if (data.startsWith('data:')) {
          data = decodeURIComponent(data.split(',')[1] ?? '');
        }
      } else {
        data = await exportToPdf(element);
      }
    } finally {
      canvasStore.setExportMode(false);
    }

    const result = await window.filo.invoke('export:save', format, data, name);
    return result;
  } catch (err) {
    // The caller (ProjectDropdown) renders the user-facing toast from the
    // returned `error` field. Keep this as a triage breadcrumb only.
    console.error('[exportService] Export failed:', err);
    return { success: false, error: String(err) };
  }
}
