<script lang="ts">
  import type { IframeTile } from '../../schema/index';
  import { isSafeIframeUrl } from '../../lib/utils/urlSafety';
  import { asSafeIframeSrc } from '../../../shared/untrusted';
  import { openExternalUrl } from '../../lib/utils/openExternal';
  import IconButton from '../shared/IconButton.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand } from '../../commands/index';

  let { tile }: { tile: IframeTile } = $props();

  let inputUrl = $derived(tile.url || '');

  // Interaction mode: when true the blocker is hidden and the iframe receives events.
  // Default is false (blocker active) so canvas pan works normally over the tile.
  let interacting = $state(false);
  let loadFailed = $state(false);

  const safety = $derived(tile.url ? isSafeIframeUrl(tile.url) : { ok: true });
  // `asSafeIframeSrc` is the canonical security gate; `safety` carries
  // the user-facing reason. Both read `iframeSrcProblem`, so they agree on
  // rejection. `safeSrc` is the value actually bound to the embed below;
  // the CI gate `scripts/gates:untrusted-sinks` enforces that the tag goes
  // through this validator.
  const safeSrc = $derived(asSafeIframeSrc(tile.url));

  function openExternally(target: string | null | undefined): void {
    if (target) void openExternalUrl(target);
  }

  function handleLoad() {
    loadFailed = false;
  }

  function handleError() {
    loadFailed = true;
  }

  function normalizeUrl(input: string): string {
    const url = input.trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    // Preserve dangerous schemes verbatim so safety validation rejects them
    // rather than silently re-writing them into something that looks safe.
    if (/^(javascript|data|vbscript|file|blob|ftp|chrome|about):/i.test(url)) return url;
    return 'https://' + url;
  }

  function handleUrlSubmit() {
    const next = normalizeUrl(inputUrl);
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'url', url: tile.url ?? '' },
        { kind: 'url', url: next },
        'Set iframe URL',
      ),
    );
  }

  function handleRemove() {
    interacting = false;
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        { kind: 'url', url: tile.url ?? '' },
        { kind: 'url', url: '' },
        'Clear iframe',
      ),
    );
  }

  function enterInteract() {
    interacting = true;
  }

  function exitInteract() {
    interacting = false;
  }
</script>

<div class="iframe-tile">
  {#if tile.url && !safety.ok}
    <div class="unsafe-blocked" role="alert">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2L2 7v6c0 5 4 9 10 11 6-2 10-6 10-11V7l-10-5z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div class="unsafe-title">Unsafe URL blocked</div>
      <div class="unsafe-reason">{safety.reason}</div>
      <button class="unsafe-clear" onclick={handleRemove}>Clear</button>
    </div>
  {:else if tile.url && safeSrc}
    <div class="iframe-container">
      <!-- allow-untrusted-sink: safeSrc is asSafeIframeSrc(tile.url) — see $derived block in <script> -->
      <iframe
        src={safeSrc}
        title={tile.title}
        sandbox="allow-scripts allow-popups"
        loading="lazy"
        onload={handleLoad}
        onerror={handleError}
      ></iframe>

      {#if loadFailed}
        <div class="load-error">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Could not load embed</span>
          <button class="hint-link" onclick={() => openExternally(tile.url)}>Open in browser instead</button>
        </div>
      {/if}

      <!-- Top bar is always present — shows actions + interact toggle.
           This keeps Open/Clear accessible even when the iframe has pointer focus. -->
      <div class="top-bar">
        <div class="top-bar-actions">
          <IconButton title="Open externally" onclick={() => openExternally(tile.url)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></IconButton>
          <IconButton title="Clear embed" danger onclick={handleRemove}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></IconButton>
          {#if interacting}
            <button class="exit-btn" onclick={exitInteract} title="Exit interact mode">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Exit
            </button>
          {/if}
        </div>
      </div>

      <!-- Blocker prevents iframe from eating canvas pan events.
           Double-click the tile to enter interact mode. -->
      {#if !interacting}
        <!-- role=button + Enter/Space give a keyboard path into interact
             mode. Double-click stays the mouse
             affordance so a single canvas click can't accidentally arm it. -->
        <div
          class="iframe-blocker"
          ondblclick={enterInteract}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterInteract(); } }}
          role="button"
          tabindex="0"
          aria-label="Interact with embedded content"
          title="Double-click (or press Enter) to interact"
        >
          <div class="interact-hint">Double-click to interact</div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="empty-state">
      <div class="icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </div>
      <div class="input-group">
        <input
          type="text"
          bind:value={inputUrl}
          placeholder="Paste embed URL..."
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrlSubmit(); } }}
        />
        <button class="btn btn-primary" onclick={handleUrlSubmit}>Embed</button>
      </div>
      <div class="hint">Use a URL that supports iframe embedding</div>
    </div>
  {/if}
</div>

<style>
  .iframe-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .iframe-container {
    position: relative;
    width: 100%;
    height: 100%;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }
  .iframe-blocker {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 1;
    cursor: pointer;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 10px;
  }
  .interact-hint {
    opacity: 0;
    font-size: 11px;
    color: var(--text-inverse);
    background: rgba(0,0,0,0.5);
    padding: 3px 8px;
    border-radius: 4px;
    pointer-events: none;
    transition: opacity 0.15s;
  }
  .iframe-blocker:hover .interact-hint {
    opacity: 1;
  }
  /* Top bar always rendered — holds Open/Clear actions and the Exit button.
     Uses pointer-events: none so the iframe below stays interactive;
     individual buttons re-enable pointer events. */
  .top-bar {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 4;
    display: flex;
    justify-content: flex-end;
    padding: 4px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, transparent 100%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .iframe-container:hover .top-bar {
    opacity: 1;
  }
  .top-bar-actions {
    display: flex;
    gap: 4px;
    align-items: center;
    pointer-events: auto;
    background: var(--ui-surface);
    border-radius: 6px;
    padding: 2px 4px;
    box-shadow: var(--ui-shadow);
  }
  .exit-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: none;
    border-radius: 4px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }
  .exit-btn:hover {
    background: var(--accent-primary-hover);
  }
  .load-error {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 13px;
    pointer-events: none;
  }
  .hint-link {
    pointer-events: auto;
    background: none;
    border: none;
    color: var(--accent-primary);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
  }

  .unsafe-blocked {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    gap: 8px;
    text-align: center;
    color: var(--text-secondary);
    background: var(--ui-surface);
  }
  .unsafe-blocked svg {
    color: var(--accent-danger, #d04444);
  }
  .unsafe-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .unsafe-reason {
    font-size: 12px;
    color: var(--text-tertiary);
    word-break: break-word;
    max-width: 100%;
  }
  .unsafe-clear {
    margin-top: 4px;
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }
  .unsafe-clear:hover {
    background: var(--ui-surface-hover, var(--ui-surface));
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
  }
  .icon {
    opacity: 0.5;
    color: var(--text-tertiary);
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
