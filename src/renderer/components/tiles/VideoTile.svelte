<script lang="ts">
  import type { VideoTile } from '../../schema/index';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { toMediaUrl } from '../../lib/utils/mediaUrl';
  import IconButton from '../shared/IconButton.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand } from '../../commands/index';

  let { tile }: { tile: VideoTile } = $props();

  let inputUrl = $state('');
  // UX-1 — surface a fallback when the video fails to load (broken/missing
  // vault path, dead URL) instead of leaving an empty black box.
  let loadFailed = $state(false);

  function handleVideoLoad() {
    loadFailed = false;
  }

  function handleVideoError() {
    loadFailed = true;
  }

  // Vault-relative paths route through the `filo://` protocol; http/data/blob
  // URLs are passed through unchanged. The filo protocol handler honours
  // HTTP Range requests so `<video>` seek/buffering works correctly.
  let displaySrc = $derived(toMediaUrl(tile.src, vaultStore.path));

  function handleUrlSubmit() {
    const next = inputUrl.trim();
    if (!next) return;
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'src', src: tile.src ?? '' },
        { kind: 'src', src: next },
        'Set video source',
      ),
    );
  }

  function handleRemove() {
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'src-with-playback', src: tile.src ?? '', isPlaying: tile.isPlaying ?? false },
        { kind: 'src-with-playback', src: '', isPlaying: false },
        'Clear video',
      ),
    );
  }

  function handlePlayState(e: Event) {
    const video = e.target as HTMLVideoElement;
    boardStore.updateTile(tile.id, { isPlaying: !video.paused });
  }
</script>

<div class="video-tile">
  {#if tile.src}
    <div class="video-container">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={displaySrc}
        controls
        onplay={handlePlayState}
        onpause={handlePlayState}
        onended={handlePlayState}
        oncanplay={handleVideoLoad}
        onerror={handleVideoError}
      >
      </video>
      {#if loadFailed}
        <div class="load-error" role="alert">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            <line x1="1" y1="5" x2="23" y2="19"/>
          </svg>
          <span>Video could not be loaded</span>
          {#if tile.src}<span class="load-error-path">{tile.src}</span>{/if}
        </div>
      {/if}
      <div class="actions">
        <IconButton  title="Remove Video" danger onclick={handleRemove} ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></IconButton>
      </div>
    </div>
  {:else}
    <div class="empty-state">
      <div class="icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
      </div>
      <div class="input-group">
        <input 
          type="text" 
          bind:value={inputUrl} 
          placeholder="Paste video URL..." 
          onkeydown={(e) => e.key === 'Enter' && handleUrlSubmit()}
        />
        <button class="btn btn-primary" onclick={handleUrlSubmit}>Add</button>
      </div>
      <div class="hint">Or drag & drop a video file</div>
    </div>
  {/if}
</div>

<style>
  .video-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #000;
  }
  .video-container {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .load-error {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 13px;
    pointer-events: none;
  }
  .load-error-path {
    font-size: 11px;
    color: var(--text-tertiary);
    word-break: break-all;
    max-width: 100%;
  }
  .actions {
    position: absolute;
    top: 8px;
    right: 8px;
    opacity: 0;
    transition: opacity 0.2s;
    background: var(--ui-surface);
    border-radius: 6px;
    box-shadow: var(--ui-shadow);
  }
  .video-container:hover .actions {
    opacity: 1;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    gap: 12px;
    text-align: center;
    background: var(--ui-surface-hover);
  }
  .icon {
    font-size: 32px;
    opacity: 0.5;
  }
  .input-group {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 300px;
  }
  input {
    flex: 1;
    padding: 6px 10px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 13px;
  }
  .btn {
    padding: 6px 12px;
    border-radius: 4px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .btn:hover {
    background: var(--accent-primary-hover);
  }
  .hint {
    font-size: 11px;
    color: var(--text-tertiary);
  }
</style>
