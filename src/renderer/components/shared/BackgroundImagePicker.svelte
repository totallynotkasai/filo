<script lang="ts">
  /**
   * BackgroundImagePicker — shared upload/remove control for a vault-relative
   * background-image path. Resolves http/data URIs and vault-relative paths
   * to a data-URL preview via `media:read-file` IPC, mirroring the renderer's
   * Chromium-security limitation (cannot load file:// URLs directly).
   *
   * Used by FrameStylePopup, CurrentBoardMindMap, BoardDefaults.
   */
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { copyFileIntoVault } from '../../lib/vault/vaultOperations';

  let {
    value,
    onChange,
    title = 'Choose Background Image',
  }: {
    value: string;
    onChange: (newValue: string) => void;
    title?: string;
  } = $props();

  let previewUrl = $state('');

  $effect(() => {
    const src = value;
    const vaultPath = vaultStore.path;
    if (!src) { previewUrl = ''; return; }
    if (src.startsWith('http') || src.startsWith('data:')) {
      previewUrl = src;
      return;
    }
    if (!vaultPath) { previewUrl = ''; return; }
    let cancelled = false;
    void window.filo.invoke('media:read-file', vaultPath, src).then((res) => {
      if (cancelled) return;
      previewUrl = res.success
        ? `data:${res.mimeType};base64,${res.data}`
        : '';
    });
    return () => { cancelled = true; };
  });

  async function upload(): Promise<void> {
    const vaultPath = vaultStore.path;
    if (!vaultPath) {
      uiStore.toast('No vault open', 'error', 2000);
      return;
    }
    const paths = await window.filo.invoke('dialog:open-file', {
      title,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    if (!paths || paths.length === 0) return;
    // Phase R2 — drain pending writers before the copy so a debounced
    // .board.json write referring to the new image path doesn't fire
    // before the file lands on disk.
    const src = paths[0];
    if (!src) return; // paths non-empty (checked above)
    const res = await copyFileIntoVault(src, vaultPath);
    if (res.success) {
      onChange(res.relativePath ?? res.path ?? '');
    } else {
      uiStore.toast(`Failed to import image: ${res.error ?? 'unknown error'}`, 'error', 3000);
    }
  }

  function remove(): void {
    onChange('');
  }
</script>

<div class="bg-image-controls">
  {#if value}
    <div class="bg-image-thumb" style="background-image: url('{previewUrl}')"></div>
    <button class="bg-image-btn" onclick={upload}>Replace</button>
    <button class="bg-image-btn danger" onclick={remove}>Remove</button>
  {:else}
    <button class="bg-image-btn primary" onclick={upload}>Upload Image</button>
  {/if}
</div>

<style>
  .bg-image-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    justify-content: flex-end;
  }

  .bg-image-thumb {
    width: 32px;
    height: 24px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background-size: cover;
    background-position: center;
    background-color: var(--ui-bg);
  }

  .bg-image-btn {
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .bg-image-btn:hover {
    background: var(--ui-bg);
    border-color: var(--ui-border-focus);
  }

  .bg-image-btn.primary {
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-color: var(--accent-primary);
  }

  .bg-image-btn.primary:hover {
    background: var(--accent-primary-hover);
    border-color: var(--accent-primary-hover);
  }

  .bg-image-btn.danger:hover {
    color: var(--accent-danger);
    border-color: var(--accent-danger);
  }
</style>
