<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { LinkTile } from '../../schema/index';
  import { openExternalUrl } from '../../lib/utils/openExternal';

  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand } from '../../commands/index';

  let { tile }: { tile: LinkTile } = $props();

  let inputUrl = $derived(tile.url || '');
  let loading = $state(false);
  let loadFailed = $state(false);
  let failureReason = $state<'offline' | 'timeout' | 'error' | null>(null);
  let isOnline = $state(typeof navigator !== 'undefined' ? navigator.onLine : true);
  let metadata = $state<{
    title: string;
    description: string;
    image: string;
    favicon: string;
    domain: string;
  } | null>(null);

  const FETCH_TIMEOUT_MS = 5000;

  function onOnline() { isOnline = true; }
  function onOffline() { isOnline = false; }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }
  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
  });

  // Fetch metadata when tile already has a URL
  $effect(() => {
    if (tile.url && !metadata && !loadFailed) {
      fetchMetadata(tile.url);
    }
  });

  function handleUrlSubmit() {
    let finalUrl = inputUrl.trim();
    if (finalUrl && !finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'https://' + finalUrl;
    }
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'url', url: tile.url ?? '' },
        { kind: 'url', url: finalUrl },
        'Set link URL',
      ),
    );
    metadata = null;
    loadFailed = false;
    failureReason = null;
    if (finalUrl) {
      fetchMetadata(finalUrl);
    }
  }

  async function fetchMetadata(url: string) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      loading = false;
      loadFailed = true;
      failureReason = 'offline';
      return;
    }

    loading = true;
    loadFailed = false;
    failureReason = null;
    metadata = null;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS);
    });

    try {
      const res = await Promise.race([
        window.filo.invoke('link:fetch-metadata', url),
        timeoutPromise,
      ]);

      if (res.success) {
        metadata = {
          title: res.title || '',
          description: res.description || '',
          image: res.image || '',
          favicon: res.favicon || '',
          domain: res.domain || '',
        };
      } else {
        loadFailed = true;
        failureReason = 'error';
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === 'timeout';
      loadFailed = true;
      failureReason = isTimeout ? 'timeout' : 'error';
      if (!isTimeout) {
        // `loadFailed = true` already renders an inline retry button —
        // skip the toast for the common case and keep a breadcrumb only.
        console.error('[LinkTile] Failed to fetch link metadata:', err);
      }
    } finally {
      if (timer) clearTimeout(timer);
      loading = false;
    }
  }

  function retry() {
    if (tile.url) fetchMetadata(tile.url);
  }

  async function openLink() {
    if (!tile.url) return;
    await openExternalUrl(tile.url);
  }
</script>

<div class="link-tile">
  <div class="link-content">
    <div class="input-group">
      <input
        type="text"
        bind:value={inputUrl}
        placeholder="https://example.com"
        onkeydown={(e) => e.key === 'Enter' && handleUrlSubmit()}
        onblur={handleUrlSubmit}
      />
    </div>

    {#if loading}
      <div class="loading-state">
        <span class="loading-spinner"></span>
        <span class="loading-text">Fetching preview...</span>
      </div>
    {:else if loadFailed && tile.url}
      <div class="load-failed">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div class="failure-text">
          {#if failureReason === 'offline' || !isOnline}
            Couldn't load preview — you're offline.
          {:else if failureReason === 'timeout'}
            Couldn't load preview — request timed out.
          {:else}
            Couldn't load preview.
          {/if}
        </div>
        <div class="failure-actions">
          <button class="retry-btn" onclick={retry} disabled={!isOnline}>Retry</button>
          <button class="open-btn-secondary" onclick={openLink} title={tile.url}>Open in browser</button>
        </div>
      </div>
    {:else if metadata && tile.url}
      <div class="metadata-preview" onclick={openLink} role="button" tabindex="0" onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openLink()}>
        {#if metadata.image}
          <div class="meta-image-container">
            <img
              class="meta-image"
              src={metadata.image}
              alt=""
              onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        {/if}
        <div class="meta-info">
          <div class="meta-header">
            {#if metadata.favicon}
              <img
                class="meta-favicon"
                src={metadata.favicon}
                alt=""
                width="16"
                height="16"
                onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            {/if}
            {#if metadata.domain}
              <span class="meta-domain">{metadata.domain}</span>
            {/if}
          </div>
          {#if metadata.title}
            <h4 class="meta-title">{metadata.title}</h4>
          {/if}
          {#if metadata.description}
            <p class="meta-description">{metadata.description}</p>
          {/if}
        </div>
      </div>
    {:else if tile.url}
      <div class="fallback-link">
        <div class="icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </div>
        <button class="open-btn" onclick={openLink} title={tile.url}>
          Open in Browser
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .link-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 12px;
    overflow: hidden;
  }
  .link-content {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
  }
  .input-group {
    width: 100%;
    flex-shrink: 0;
  }
  input {
    width: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
  }
  input:focus {
    outline: 2px solid var(--accent-primary);
    border-color: transparent;
  }

  /* Loading */
  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .loading-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--ui-border);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Metadata preview */
  .metadata-preview {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--ui-border-light);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: box-shadow 0.2s ease;
    min-height: 0;
  }
  .metadata-preview:hover {
    box-shadow: var(--ui-shadow);
  }
  .meta-image-container {
    width: 100%;
    max-height: 140px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .meta-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .meta-info {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
  }
  .meta-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .meta-favicon {
    flex-shrink: 0;
    border-radius: 2px;
  }
  .meta-domain {
    font-size: 11px;
    color: var(--text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.3;
  }
  .meta-description {
    font-size: 11px;
    color: var(--text-secondary);
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
  }

  /* Load failed */
  .load-failed {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: 1;
    padding: 12px;
    text-align: center;
    color: var(--text-secondary);
  }
  .load-failed svg {
    color: var(--text-tertiary);
  }
  .failure-text {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .failure-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .retry-btn {
    padding: 4px 10px;
    border-radius: 4px;
    border: none;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .retry-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .retry-btn:not(:disabled):hover {
    background: var(--accent-primary-hover, var(--accent-primary));
  }
  .open-btn-secondary {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    font-size: 12px;
    cursor: pointer;
    background: var(--ui-surface);
    color: var(--text-primary);
  }
  .open-btn-secondary:hover {
    background: var(--ui-surface-hover, var(--ui-surface));
  }

  /* Fallback (no metadata) */
  .fallback-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex: 1;
  }
  .icon {
    color: var(--text-tertiary);
  }
  .open-btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: var(--accent-primary);
    color: var(--text-inverse);
    transition: background-color 0.15s ease;
  }
  .open-btn:hover {
    background: var(--accent-primary-hover);
  }
</style>
