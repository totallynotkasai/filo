<script lang="ts">
  import type { FileTile } from '../../schema/index';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { invokeOk } from '../../lib/utils/invokeOk';
  import { normalizePath, toPosix } from '../../lib/utils/path';
  import { asSafeOpenExternal } from '../../../shared/untrusted';
  import { copyFileIntoVault } from '../../lib/vault/vaultOperations';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { uiStore } from '../../stores/ui.svelte';
  import IconButton from '../shared/IconButton.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand } from '../../commands/index';

  let { tile }: { tile: FileTile } = $props();
  let picking = $state(false);

  async function handleOpen() {
    if (!tile.filePath) return;
    try {
      // filePath is stored as a vault-relative POSIX path; resolve to absolute
      // before handing to the OS shell. The main process validates with
      // assertWithinVault so this can't escape the vault.
      const vaultRoot = vaultStore.path;
      const abs = vaultRoot
        ? `${normalizePath(vaultRoot)}/${tile.filePath}`
        : tile.filePath;
      // Phase 5 — `asSafeOpenExternal` rejects local paths carrying an
      // unsafe extension (.html, .svg, .exe etc.) before the IPC call.
      // The main handler re-checks (defence-in-depth) — see
      // `media.ipc.ts:UNSAFE_FILE_EXTENSIONS`.
      const safe = asSafeOpenExternal(abs);
      if (!safe) { reportError('FileTile.open', null, `Refusing to open ${tile.fileName || tile.filePath} — file extension not allowed.`); return; }
      await invokeOk('media:open-external', safe);
    } catch (err) {
      reportError(
        'FileTile.open',
        err,
        `Failed to open ${tile.fileName || tile.filePath} externally`,
      );
    }
  }

  /**
   * Opens a native file picker and copies the chosen file into the vault
   * under `attachments/{tile.id}/` so the file travels with the project. The
   * tile only stores the vault-relative path.
   */
  async function handleChooseFile() {
    if (picking) return;
    const vaultDir = vaultStore.path;
    if (!vaultDir) {
      uiStore.toast('Save the project first to enable file import', 'info', 2000);
      return;
    }

    picking = true;
    try {
      const paths = await window.filo.invoke('dialog:open-file', {
        title: 'Choose a file to attach',
      });
      if (!paths || paths.length === 0) return;

      const sourcePath = paths[0];
      if (!sourcePath) return; // paths non-empty (checked above)
      // Phase R2 — drain pending writers before the copy so a debounced
      // tile-definition write doesn't fire against a stale `filePath`
      // before the new file lands on disk.
      const res = await copyFileIntoVault(sourcePath, vaultDir);

      if (!res.success) {
        reportError(
          'FileTile.import',
          res.error ?? null,
          `Failed to import "${toPosix(sourcePath).split('/').pop() ?? 'file'}" into the vault`,
        );
        return;
      }

      const storedPath = res.relativePath || res.path || '';
      const fileName = toPosix(sourcePath).split('/').pop() || 'file';
      const fileExtension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';

      historyStore.execute(
        new UpdateAttachmentSrcCommand(
          tile.id,
          {
            kind: 'file',
            filePath: tile.filePath ?? '',
            fileName: tile.fileName ?? '',
            fileExtension: tile.fileExtension ?? '',
          },
          { kind: 'file', filePath: storedPath, fileName, fileExtension },
          'Set file attachment',
        ),
      );
    } catch (err) {
      reportError('FileTile.import', err, 'Failed to import file into the vault');
    } finally {
      picking = false;
    }
  }

  function handleRemove() {
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        {
          kind: 'file',
          filePath: tile.filePath ?? '',
          fileName: tile.fileName ?? '',
          fileExtension: tile.fileExtension ?? '',
        },
        { kind: 'file', filePath: '', fileName: '', fileExtension: '' },
        'Clear file attachment',
      ),
    );
  }

  let iconType = $derived(
    tile.fileExtension.match(/pdf/i) ? 'pdf' :
    tile.fileExtension.match(/doc|docx/i) ? 'doc' :
    tile.fileExtension.match(/xls|xlsx|csv/i) ? 'spreadsheet' :
    tile.fileExtension.match(/zip|tar|gz|rar/i) ? 'archive' :
    'generic'
  );
</script>

<div class="file-tile">
  {#if tile.filePath}
    <div class="file-container">
      <div class="file-icon" aria-hidden="true">
        {#if iconType === 'pdf'}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          </svg>
        {:else if iconType === 'doc'}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        {:else if iconType === 'spreadsheet'}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
            <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
        {:else if iconType === 'archive'}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/>
            <line x1="10" y1="12" x2="14" y2="12"/>
          </svg>
        {:else}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        {/if}
      </div>
      <div class="file-info">
        <div class="file-name" title={tile.fileName}>{tile.fileName}</div>
        <div class="file-ext">{tile.fileExtension.toUpperCase()} File</div>
      </div>
      <button class="open-btn" onclick={handleOpen}>Open Externally</button>
      
      <div class="actions">
        <IconButton  title="Remove File" danger onclick={handleRemove} ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></IconButton>
      </div>
    </div>
  {:else}
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m7.5 4.27 9 5.15"/>
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
          <path d="m3.3 7 8.7 5 8.7-5"/>
          <path d="M12 22V12"/>
        </svg>
      </div>
      <button class="choose-btn" onclick={handleChooseFile} disabled={picking}>
        {picking ? 'Importing…' : 'Choose File'}
      </button>
      <div class="hint">Or drag & drop a file here</div>
    </div>
  {/if}
</div>

<style>
  .file-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    justify-content: center;
  }
  .file-container {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
  }
  .file-info {
    width: 100%;
  }
  .file-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-ext {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 4px;
  }
  .open-btn {
    margin-top: 8px;
    padding: 6px 12px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }
  .open-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    border-color: var(--text-tertiary);
  }
  .actions {
    position: absolute;
    top: -8px;
    right: -8px;
    opacity: 0;
    transition: opacity 0.2s;
    background: var(--ui-surface);
    border-radius: 6px;
    box-shadow: var(--ui-shadow);
  }
  .file-tile:hover .actions {
    opacity: 1;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    border: 2px dashed var(--ui-border);
    border-radius: 8px;
    background: rgba(0,0,0,0.02);
  }
  .empty-icon {
    opacity: 0.4;
    color: var(--text-secondary);
  }
  .hint {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .choose-btn {
    padding: 6px 14px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }
  .choose-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    border-color: var(--text-tertiary);
  }
  .choose-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }
</style>
