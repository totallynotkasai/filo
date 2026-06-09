<script lang="ts">
  import type { FileTreeNode } from '../../../shared/types';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { boardTypeForPath } from '../../lib/vault/boardTypeForPath';
  import { BOARD_TYPE_ICON_PATH } from '../../constants/boardIcons';

  interface Props {
    node: FileTreeNode;
    expanded?: boolean;
  }

  let { node, expanded = false }: Props = $props();

  type FileIconType =
    | 'folder-open'
    | 'folder-closed'
    | 'board'
    | 'markdown'
    | 'json'
    | 'image'
    | 'video'
    | 'audio'
    | 'pdf'
    | 'document'
    | 'spreadsheet'
    | 'archive'
    | 'filo'
    | 'generic';

  // A `.board.json` file gets its board-type glyph — the SAME icon the +New-board
  // menu shows (constants/boardIcons.ts), so the surfaces stay in sync. Document
  // boards and not-yet-loaded boards return null and fall through to the generic
  // JSON icon. Resolved from in-memory stores (eagerly loaded at vault open) — no
  // IPC / disk read.
  const boardIconPath = $derived.by<string | null>(() => {
    if (node.isDirectory) return null;
    if (!node.name.toLowerCase().endsWith('.board.json')) return null;
    const type = boardTypeForPath(
      node.path,
      vaultStore.path,
      vaultStore.project?.boards ?? [],
      boardCacheStore.paths,
    );
    if (type === 'mindmap' || type === 'kanban' || type === 'tasklist') {
      return BOARD_TYPE_ICON_PATH[type];
    }
    return null; // document / unresolved → generic JSON icon
  });

  const kind = $derived.by<FileIconType>(() => {
    if (node.isDirectory) return expanded ? 'folder-open' : 'folder-closed';
    if (boardIconPath) return 'board';
    const ext = (node.extension ?? '').toLowerCase();
    switch (ext) {
      case '.md':
      case '.markdown':
        return 'markdown';
      case '.json':
        return 'json';
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.webp':
      case '.svg':
      case '.bmp':
      case '.avif':
        return 'image';
      case '.mp4':
      case '.webm':
      case '.mov':
      case '.mkv':
        return 'video';
      case '.mp3':
      case '.wav':
      case '.ogg':
      case '.flac':
      case '.m4a':
        return 'audio';
      case '.pdf':
        return 'pdf';
      case '.doc':
      case '.docx':
      case '.rtf':
      case '.odt':
        return 'document';
      case '.xls':
      case '.xlsx':
      case '.csv':
      case '.ods':
        return 'spreadsheet';
      case '.zip':
      case '.tar':
      case '.gz':
      case '.rar':
      case '.7z':
        return 'archive';
      case '.filo':
        return 'filo';
      default:
        return 'generic';
    }
  });
</script>

{#if kind === 'folder-open'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>
  </svg>
{:else if kind === 'folder-closed'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
{:else if kind === 'board'}
  <!-- Board → the same board-type glyph as the +New-board menu (constants/boardIcons.ts) -->
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={boardIconPath ?? ''}/>
  </svg>
{:else if kind === 'markdown'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2"/>
    <path d="M7 15V9l3 4 3-4v6"/>
    <path d="M17 9v6"/>
    <polyline points="14 13 17 16 20 13"/>
  </svg>
{:else if kind === 'json'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <path d="M10 13a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/>
    <path d="M14 13a1 1 0 0 1 1 1v1a1 1 0 0 0 1 1 1 1 0 0 0-1 1v1a1 1 0 0 1-1 1"/>
  </svg>
{:else if kind === 'image'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
{:else if kind === 'video'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="23 7 16 12 23 17 23 7"/>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
  </svg>
{:else if kind === 'audio'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>
{:else if kind === 'pdf'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
{:else if kind === 'document'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
{:else if kind === 'spreadsheet'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="3" y1="9" x2="21" y2="9"/>
    <line x1="3" y1="15" x2="21" y2="15"/>
    <line x1="9" y1="3" x2="9" y2="21"/>
    <line x1="15" y1="3" x2="15" y2="21"/>
  </svg>
{:else if kind === 'archive'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="21 8 21 21 3 21 3 8"/>
    <rect x="1" y="3" width="22" height="5"/>
    <line x1="10" y1="12" x2="14" y2="12"/>
  </svg>
{:else if kind === 'filo'}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>
{:else}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
{/if}

<style>
  svg {
    width: 14px;
    height: 14px;
  }
</style>
