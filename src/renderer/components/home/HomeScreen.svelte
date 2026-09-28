<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { pickAndOpenVault, rememberOpenVault, type RecentVault } from '../../stores/vaultOpen';
  import FiloLogo from '../shared/FiloLogo.svelte';
  import { safeVaultColor } from '../../../shared/vaultColor';
  import type { OpenVaultReport } from '../../lib/vault/vaultOpenFailure';
  interface Props {
    onReturnToVault?: () => void;
  }

  let { onReturnToVault }: Props = $props();

  // Ctrl+N (New Vault), which the footer advertises, belongs to this screen
  // only: elsewhere Ctrl+N adds to the board. Ctrl+O is the global `vault:open`
  // command (AppShell), so it isn't handled here as well.
  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void handleNewVault();
      }
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  let recentVaults = $state<RecentVault[]>([]);
  let autoOpenAttempted = $state(false);
  // One open at a time: while one runs (the launch auto-open included), the
  // cards are disabled and the vault being opened shows a spinner.
  let openingPath = $state<string | null>(null);
  const busy = $derived(vaultStore.lifecycleBusy);

  // Load recent vaults from the main-process userData store, then attempt
  // auto-open if the user has the "Open last vault on launch" preference
  // enabled. The auto-open runs at most once per HomeScreen mount.
  $effect(() => {
    void loadRecents();
    if (!autoOpenAttempted) {
      autoOpenAttempted = true;
      void maybeAutoOpenLastVault();
    }
  });

  async function loadRecents(): Promise<void> {
    try {
      const list = await window.filo.invoke('vault:list-recents');
      recentVaults = Array.isArray(list) ? list : [];
    } catch {
      recentVaults = [];
    }
  }

  async function maybeAutoOpenLastVault(): Promise<void> {
    // Skip when a vault is already open (e.g. HomeScreen revisited from a
    // running session).
    if (vaultStore.project !== null) return;
    try {
      const pref = await window.filo.invoke('vault:get-launch-preference');
      if (!pref.openOnLaunch) return;
    } catch {
      return;
    }
    // Pick the most-recently-opened vault. Pinned-ness is irrelevant for
    // auto-open — last-use wins so the user lands where they left off.
    const candidate = [...recentVaults].sort((a, b) => b.lastOpened - a.lastOpened)[0];
    if (candidate) await openRecent(candidate, 'Last vault');
  }

  /**
   * Opens a recent vault. The entry is dropped only when its folder is
   * confirmed gone, and never when it is pinned: staying in the current vault,
   * a drive that is unplugged for now, or any other failure leaves it listed.
   */
  async function openRecent(recent: RecentVault, label: string): Promise<void> {
    const report: OpenVaultReport = {};
    let loaded = false;
    openingPath = recent.path;
    try {
      loaded = await vaultStore.openVault(recent.path, report);
    } catch {
      uiStore.toast('Failed to open vault', 'error');
      return;
    } finally {
      openingPath = null;
    }
    if (loaded) {
      await saveRecentVault();
      onReturnToVault?.();
      return;
    }
    if (report.failure === 'missing') {
      uiStore.toast(
        recent.pinned
          ? `${label} "${recent.name}" wasn't found. It may have been moved or deleted; it stays pinned until you remove it.`
          : `${label} "${recent.name}" wasn't found. It may have been moved or deleted, so it was removed from the list.`,
        'warning',
      );
      if (!recent.pinned) await removeRecent(recent.path);
    } else if (report.failure === 'unavailable') {
      uiStore.toast(`${label} "${recent.name}" isn't available right now. Check that its drive or network share is connected.`, 'warning');
    }
  }

  // Pinned-first, then by most-recently-opened.
  let sortedRecentVaults = $derived(
    [...recentVaults].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.lastOpened - a.lastOpened;
    }),
  );

  async function removeRecent(path: string): Promise<void> {
    try {
      const updated = await window.filo.invoke('vault:remove-recent', path);
      if (Array.isArray(updated)) recentVaults = updated;
    } catch { /* non-critical */ }
  }

  async function togglePin(path: string): Promise<void> {
    const current = recentVaults.find((p) => p.path === path);
    if (!current) return;
    try {
      const updated = await window.filo.invoke('vault:pin-recent', path, !current.pinned);
      if (Array.isArray(updated)) recentVaults = updated;
    } catch { /* non-critical */ }
  }

  function clearAllRecent() {
    const pinnedCount = recentVaults.filter((p) => p.pinned).length;
    const unpinnedCount = recentVaults.length - pinnedCount;
    uiStore.openConfirm({
      title: 'Clear recent vaults',
      body: pinnedCount > 0
        ? `Remove all ${unpinnedCount} unpinned recent vault${unpinnedCount === 1 ? '' : 's'}? Pinned vaults are kept.`
        : `Remove all ${recentVaults.length} recent vault${recentVaults.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Clear',
      danger: true,
      onConfirm: async () => {
        try {
          const updated = await window.filo.invoke('vault:clear-recents');
          if (Array.isArray(updated)) recentVaults = updated;
        } catch { /* non-critical */ }
      },
    });
  }

  async function handleOpenVault() {
    if (await pickAndOpenVault()) onReturnToVault?.();
  }

  async function handleNewVault() {
    const vaultPath = await window.filo.invoke('vault:select');
    if (!vaultPath) return;
    const name = vaultPath.split(/[\\/]/).pop() || 'Vault';
    const loaded = await vaultStore.newVault(vaultPath, name);
    if (loaded) {
      await saveRecentVault();
      onReturnToVault?.();
    }
  }

  async function handleOpenRecent(recent: RecentVault) {
    await openRecent(recent, 'Vault');
  }

  // Records the vault just opened under its own name and colour (it may have
  // been renamed or recoloured since the entry was written). A failed add
  // leaves the shown list as it was rather than wiping it.
  async function saveRecentVault(): Promise<void> {
    const recents = await rememberOpenVault();
    if (recents) recentVaults = recents;
  }

  function formatDate(ts: number): string {
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  }
</script>

<div class="home-screen">
  <div class="home-content">
    <!-- Logo and Title -->
    <div class="home-header">
      <div class="home-logo">
        <FiloLogo size={128} />
      </div>
      <h1 class="home-title">Filo</h1>
      <p class="home-subtitle">Personal Knowledge Management</p>
      <p class="home-explainer">A vault is a folder of your Markdown notes and board files.</p>
    </div>

    <!-- Return to the open vault -->
    {#if vaultStore.project !== null}
      <button class="action-card return-card" onclick={onReturnToVault}>
        <div class="action-icon return-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </div>
        <span class="action-title">Return to vault</span>
        <span class="action-desc">{vaultStore.projectName || 'Untitled vault'}</span>
      </button>
    {/if}

    <!-- Actions -->
    <div class="home-actions home-actions-vault">
      <button class="action-card" onclick={handleNewVault} disabled={busy}>
        <div class="action-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        </div>
        <span class="action-title">New Vault</span>
        <span class="action-desc">Create a new vault folder</span>
      </button>

      <button class="action-card" onclick={handleOpenVault} disabled={busy}>
        <div class="action-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <span class="action-title">Open Vault</span>
        <span class="action-desc">Open an existing vault folder</span>
      </button>
    </div>

    <!-- Keyboard shortcuts hint -->
    <div class="shortcut-hint">
      <span>Ctrl+N</span> New Vault &nbsp;&middot;&nbsp; <span>Ctrl+O</span> Open Vault
    </div>

    <!-- Recent vaults -->
    {#if recentVaults.length > 0}
      <div class="recent-section">
        <div class="recent-header">
          <h2 class="recent-title">Recent vaults</h2>
          <button
            class="recent-clear-all"
            onclick={clearAllRecent}
            title="Clear all unpinned recent vaults"
            aria-label="Clear all recent vaults"
          >Clear all</button>
        </div>
        <div class="recent-list">
          {#each sortedRecentVaults as recent, i (recent.path)}
            <!-- A non-button row with sibling buttons: a <button> wrapping the
                 pin/remove controls would be invalid HTML (interactive
                 descendants) and break AT. -->
            <div class="recent-item" class:pinned={recent.pinned} style="animation-delay: {i * 0.04}s">
              <button class="recent-open" onclick={() => handleOpenRecent(recent)} aria-label="Open {recent.name}" disabled={busy}>
                <span
                  class="recent-icon"
                  class:tinted={safeVaultColor(recent.color) !== ''}
                  style:--vault-color={safeVaultColor(recent.color) || null}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </span>
                <span class="recent-info">
                  <span class="recent-name">{recent.name}</span>
                  <span class="recent-path" title={recent.path}>{recent.path}</span>
                </span>
                {#if openingPath === recent.path}
                  <span class="recent-opening" role="status">
                    <svg class="recent-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
                    </svg>
                    Opening…
                  </span>
                {:else}
                  <span class="recent-date">{formatDate(recent.lastOpened)}</span>
                {/if}
              </button>
              <button
                class="recent-pin"
                class:active={recent.pinned}
                onclick={() => togglePin(recent.path)}
                title={recent.pinned ? 'Unpin' : 'Pin to top'}
                aria-label={recent.pinned ? `Unpin ${recent.name}` : `Pin ${recent.name} to top`}
              >
                {#if recent.pinned}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 17v5"/>
                    <path d="M9 10.76V6h6v4.76l3 3.24v3H6v-3z"/>
                  </svg>
                {:else}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 17v5"/>
                    <path d="M9 10.76V6h6v4.76l3 3.24v3H6v-3z"/>
                  </svg>
                {/if}
              </button>
              <button
                class="recent-remove"
                onclick={() => removeRecent(recent.path)}
                title="Remove from recent"
                aria-label="Remove {recent.name} from recent vaults"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p class="empty-text">No recent vaults</p>
        <p class="empty-subtext">Create a new vault or open an existing one to get started</p>
      </div>
    {/if}

    <div class="home-footer">
      <span class="footer-text">Filo &mdash; Organize your thoughts visually</span>
    </div>
  </div>
</div>

<style>
  .home-screen {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ui-bg);
    background-image: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--accent-primary) 6%, transparent) 0%, transparent 60%);
    overflow-y: auto;
    padding: 40px 20px;
  }

  .home-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 32px;
    max-width: 560px;
    width: 100%;
  }

  .home-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .home-logo {
    opacity: 0.95;
    animation: homeSlideIn 0.4s ease;
  }

  @keyframes homeSlideIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .home-title {
    font-size: 52px;
    font-weight: 700;
    letter-spacing: -2px;
    margin: 0;
    color: var(--text-primary);
  }

  .home-subtitle {
    font-size: 16px;
    color: var(--text-tertiary);
    margin: 0;
    letter-spacing: 0.5px;
  }

  .home-explainer {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    margin: 8px 0 0;
  }

  .home-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    width: 100%;
    max-width: 400px;
  }

  .action-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px 16px;
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    background: var(--ui-surface);
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
    text-align: center;
    animation: homeSlideIn 0.4s ease backwards;
  }

  .home-actions-vault {
    max-width: 400px;
  }

  .action-card:nth-child(1) { animation-delay: 0.1s; }
  .action-card:nth-child(2) { animation-delay: 0.15s; }

  .return-card {
    width: 100%;
    border-color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
    flex-direction: row;
    justify-content: flex-start;
    padding: 16px 20px;
    animation-delay: 0.05s;
  }

  .return-card:hover {
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
    border-color: var(--accent-primary);
  }

  .return-card .action-title {
    margin-right: auto;
  }

  .return-card .action-desc {
    color: var(--accent-primary);
    font-weight: 500;
  }

  .return-icon {
    background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
    width: 36px;
    height: 36px;
  }

  .action-card:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    border-color: var(--accent-primary);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-primary) 12%, transparent);
  }

  .action-card:active {
    transform: translateY(0);
  }

  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
    color: var(--accent-primary);
  }

  .action-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .action-desc {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .recent-section {
    width: 100%;
  }

  .recent-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .recent-clear-all {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-tertiary);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.1s ease, border-color 0.1s ease;
  }

  .recent-clear-all:hover {
    color: var(--accent-danger);
    border-color: var(--ui-border);
  }

  .recent-pin {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
  }

  .recent-pin.active,
  .recent-item:hover .recent-pin {
    opacity: 1;
  }

  .recent-pin.active {
    color: var(--accent-primary);
  }

  .recent-pin:hover {
    color: var(--accent-primary);
  }

  .recent-item.pinned {
    border-left: 2px solid var(--accent-primary);
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .recent-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    transition: background-color 0.1s ease, border-color 0.1s ease;
    width: 100%;
  }

  .recent-item:hover {
    background: var(--ui-surface-hover);
    border-color: var(--ui-border);
  }

  .recent-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-family: var(--font-system);
  }

  .recent-open:disabled,
  .action-card:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .recent-opening {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .recent-spinner {
    animation: recent-spin 0.9s linear infinite;
  }

  @keyframes recent-spin {
    to { transform: rotate(360deg); }
  }

  .recent-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  /* The vault's colour: the icon in it, on a faint wash of it. */
  .recent-icon.tinted {
    color: var(--vault-color, var(--text-tertiary));
    background: color-mix(in srgb, var(--vault-color, transparent) 18%, transparent);
  }

  .recent-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-name {
    font-size: var(--font-size-base);
    font-weight: 500;
    color: var(--text-primary);
  }

  .recent-path {
    font-size: 11px;
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-date {
    font-size: 11px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .recent-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.1s ease, color 0.1s ease;
    padding: 0;
  }

  .recent-item:hover .recent-remove {
    opacity: 1;
  }

  .recent-remove:hover {
    color: var(--accent-danger);
  }

  .recent-item {
    animation: homeSlideIn 0.3s ease backwards;
  }

  .shortcut-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    text-align: center;
  }

  .shortcut-hint span {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--text-secondary);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 16px;
    width: 100%;
  }

  .empty-text {
    font-size: 15px;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 0;
  }

  .empty-subtext {
    font-size: var(--font-size-base);
    color: var(--text-tertiary);
    margin: 0;
  }

  .home-footer {
    padding-top: 16px;
    text-align: center;
  }

  .footer-text {
    font-size: 11px;
    color: var(--text-tertiary);
    opacity: 0.6;
  }

  @media (prefers-reduced-motion: reduce) {
    .home-logo,
    .action-card,
    .recent-item,
    .recent-spinner {
      animation: none;
    }
  }
</style>
