<script lang="ts">
  import {
    getAllShortcuts,
    getDefaultBinding,
    getHotkeyOverrides,
    setHotkeyOverride,
    formatShortcut,
    bindingFromEvent,
    saveHotkeyOverrides,
    type ShortcutBinding,
  } from '../../core/hotkeys';
  import { helpBindingConflict, helpDefaultBinding, helpSections } from '../../lib/settings/shortcutHelp';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';

  let activeTab = $state<'shortcuts' | 'about'>('shortcuts');

  // Bumped to force re-derivation after rebinds (the registry is mutated in place).
  let revision = $state(0);

  // Active capture state: when the user clicks a binding cell, we listen for
  // the next key combo and apply it.
  let capturingCommandId = $state<string | null>(null);
  let captureError = $state<string>('');

  // Keep the about content as before.
  const aboutSections = [
    { term: 'Vault', definition: 'A vault is simply a standard folder on your computer or device. Filo stores all of its information within this folder. You can connect your vault to a cloud storage service such as Google Drive, Dropbox, OneDrive, etc. You can create notes, folders and subfolders to organize your information how you want: right-click a folder in the vault sidebar (or the space below the files) and choose New note or New folder. Ctrl+N in a Document tab makes a note beside the one it shows.' },
    { term: 'Board', definition: 'A board is a canvas where you can create and manage your content. A board can be of any type, such as a Mind Map, Kanban Board, Task List, or Document. Files can be dragged onto a board — Filo creates the relevant tile type to contain the file.' },
    { term: 'Tile', definition: 'A tile is a container for content that can be placed on any board. Tiles can be moved, resized, and deleted. Types include Text, Image, Video, Audio, File, Link, Iframe (Embed), and Timer. Text tiles can be expanded into a full Document board.' },
    { term: 'Tags', definition: 'A tag is a label that can be applied to a tile. Tags can be used to organize and filter tiles across your vault.' },
    { term: 'Links', definition: 'A link in a note can open a web page, or another board, tile, card, task or note in your vault. Right-click a tab, a tile, a card, a task, or a note or board in the vault sidebar and choose Copy link, then paste it into a note (it reads as the name of what it links to), or into Insert Link (Ctrl+K). Ctrl+click a link to follow it while you are editing; a click follows it everywhere else.' },
    { term: 'Tabs', definition: 'Tabs are used to organize boards and switch between them. The Tab Bar is located at the bottom of the screen. Use the Board Browser button to quickly open and close tabs.' },
  ];

  // Every key by area: the commands that work everywhere, then each board's
  // (whether or not one is open) with its fixed keys, then the text's.
  const sections = $derived.by(() => {
    void revision;
    return helpSections(getAllShortcuts(), getHotkeyOverrides());
  });

  const overrides = $derived.by(() => {
    void revision;
    return getHotkeyOverrides();
  });

  function isOverridden(commandId: string): boolean {
    return Boolean(overrides[commandId]);
  }

  /** The command `binding` would collide with if `commandId` took it, or null. */
  function conflictFor(binding: ShortcutBinding, commandId: string): string | null {
    return helpBindingConflict(binding, commandId, getAllShortcuts(), getHotkeyOverrides());
  }

  function commitChange() {
    revision++;
    if (vaultStore.path) {
      // Debounced via scheduleMiscWrite — rapid sequential rebinds coalesce
      // into one disk write, mirroring how tags / configs are saved.
      saveHotkeyOverrides(vaultStore.path);
    }
  }

  function startCapture(commandId: string) {
    captureError = '';
    capturingCommandId = commandId;
  }

  function cancelCapture() {
    capturingCommandId = null;
    captureError = '';
  }

  // OS-reserved combos we cannot reliably intercept (window manager swallows them).
  const RESERVED_COMBOS: ShortcutBinding[] = [
    // Ctrl+Alt+Delete on Windows is fully blocked by the OS.
    { key: 'Delete', ctrl: true, alt: true },
    // F4 with Alt closes the window
    { key: 'F4', alt: true },
  ];

  function isReserved(b: ShortcutBinding): boolean {
    return RESERVED_COMBOS.some((r) =>
      r.key.toLowerCase() === b.key.toLowerCase()
        && Boolean(r.ctrl) === Boolean(b.ctrl)
        && Boolean(r.shift) === Boolean(b.shift)
        && Boolean(r.alt) === Boolean(b.alt),
    );
  }

  async function handleCaptureKeydown(e: KeyboardEvent) {
    if (!capturingCommandId) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cancelCapture();
      return;
    }

    const binding = bindingFromEvent(e);
    if (!binding) return;

    if (isReserved(binding)) {
      captureError = `${formatShortcut(binding)} is reserved by the OS.`;
      return;
    }

    const conflict = conflictFor(binding, capturingCommandId);
    if (conflict) {
      captureError = `${formatShortcut(binding)} is already bound to "${conflict}". Change or reset that shortcut below first, then try again.`;
      return;
    }

    setHotkeyOverride(capturingCommandId, binding);
    capturingCommandId = null;
    captureError = '';
    await commitChange();
    uiStore.toast('Shortcut updated', 'success', 1500);
  }

  async function resetBinding(commandId: string) {
    const def = helpDefaultBinding(commandId, getDefaultBinding(commandId));
    if (!def) return;
    const conflict = conflictFor(def, commandId);
    if (conflict) {
      uiStore.toast(`Default ${formatShortcut(def)} is currently bound to ${conflict}.`, 'error', 2500);
      return;
    }
    setHotkeyOverride(commandId, null);
    await commitChange();
    uiStore.toast('Reset to default', 'info', 1500);
  }

  // Listen for key events globally while capturing — input/textarea filters
  // in hotkeys.ts don't apply here because we're not on the registered
  // listener path. Capture phase ensures we beat any modal handlers.
  $effect(() => {
    if (!capturingCommandId) return;
    function onKeydown(e: KeyboardEvent) {
      void handleCaptureKeydown(e);
    }
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });
</script>

<div class="help-content">
  <div class="tab-bar">
    <button
      class="tab-btn"
      class:active={activeTab === 'shortcuts'}
      onclick={() => activeTab = 'shortcuts'}
    >Shortcuts</button>
    <button
      class="tab-btn"
      class:active={activeTab === 'about'}
      onclick={() => activeTab = 'about'}
    >About</button>
  </div>

  {#if activeTab === 'shortcuts'}
    <div class="shortcuts-content">
      <p class="shortcuts-hint">Click a shortcut to rebind it. Press Escape to cancel. The keys of rows, cards and text can't be rebound.</p>

      {#if captureError}
        <p class="capture-error" role="alert">{captureError}</p>
      {/if}

      {#each sections as section (section.title)}
        <div class="shortcut-section" data-area={section.title}>
          <h3 class="section-title">{section.title}</h3>
          <div class="shortcut-list">
            {#each section.commands as c (c.id)}
              {@const capturing = capturingCommandId === c.id}
              <div class="shortcut-row">
                <span class="shortcut-desc">{c.label}</span>
                <div class="shortcut-controls">
                  {#if c.rebindable}
                    <button
                      class="shortcut-key-btn"
                      class:capturing
                      class:overridden={isOverridden(c.id)}
                      onclick={() => capturing ? cancelCapture() : startCapture(c.id)}
                      title={capturing ? 'Press the new shortcut, or Escape to cancel' : 'Click to rebind'}
                    >
                      {capturing ? 'Press keys…' : formatShortcut(c.binding)}
                    </button>
                    {#if isOverridden(c.id)}
                      <button
                        class="reset-btn"
                        onclick={() => resetBinding(c.id)}
                        title="Reset to default"
                        aria-label="Reset to default"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
                          <path d="M3 3v5h5"/>
                        </svg>
                      </button>
                    {/if}
                  {:else}
                    <kbd class="shortcut-key">{formatShortcut(c.binding)}</kbd>
                  {/if}
                </div>
              </div>
            {/each}
            {#each section.fixed as item (item.keys)}
              <div class="shortcut-row fixed">
                <span class="shortcut-desc">{item.description}</span>
                <kbd class="shortcut-key">{item.keys}</kbd>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="about-content">
      {#each aboutSections as section (section.term)}
        <div class="about-item">
          <h3 class="about-term">{section.term}</h3>
          <p class="about-def">{section.definition}</p>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .help-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .tab-bar {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--ui-border);
    padding-bottom: 0;
  }

  .tab-btn {
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .tab-btn:hover {
    color: var(--text-primary);
  }

  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .shortcuts-content {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .shortcuts-hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .shortcut-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
  }

  .shortcut-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    transition: background-color 0.1s ease;
  }

  .shortcut-row:hover {
    background: var(--ui-surface-hover);
  }

  .shortcut-desc {
    font-size: var(--font-size-base);
    color: var(--text-primary);
  }

  .shortcut-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .shortcut-key {
    font-size: 12px;
    font-family: var(--font-mono);
    padding: 2px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .shortcut-key-btn {
    font-size: 12px;
    font-family: var(--font-mono);
    padding: 2px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease;
    min-width: 80px;
  }

  .shortcut-key-btn:hover {
    background: var(--ui-surface-active);
    color: var(--text-primary);
  }

  .shortcut-key-btn.capturing {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--ui-surface-active);
  }

  .shortcut-key-btn.overridden {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .reset-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .reset-btn:hover {
    background: var(--ui-surface-active);
    color: var(--text-primary);
  }

  .capture-error {
    margin: 4px 0 0;
    padding: 6px 8px;
    font-size: 12px;
    color: var(--accent-danger);
    background: var(--menu-danger-bg);
    border-radius: 4px;
  }

  .about-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .about-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .about-term {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .about-def {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }
</style>
