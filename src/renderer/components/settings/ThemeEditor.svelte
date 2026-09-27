<script lang="ts">
  /**
   * ThemeEditor — edits a theme's colours with a live preview.
   *
   * Every change paints at once (`themeStore.preview`), coalesced to one
   * paint per frame while a colour wheel is dragged. Save writes the file and
   * makes it the active theme; Cancel, closing Settings or leaving the vault
   * paints the active theme again, so an unsaved preview never sticks.
   */
  import { onDestroy, untrack } from 'svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { THEME_TOKEN_GROUPS } from '../../lib/themes/themeTokens';
  import {
    buildThemeFile,
    themeNameProblem,
    THEME_NAME_MAX,
    type ThemeEditorSession,
  } from '../../lib/themes/themeFiles';
  import { asSafeThemeValue } from '../../../shared/untrusted';
  import { captureVaultIdentity, isStillSameVault } from '../../lib/vault/vaultIdentity';

  interface Props {
    session: ThemeEditorSession;
    onclose: () => void;
  }

  let { session, onclose }: Props = $props();

  const initial = untrack(() => session);
  let name = $state(initial.name);
  let variables = $state<Record<string, string>>({ ...initial.variables });
  let openGroups = $state<Record<string, boolean>>({ [THEME_TOKEN_GROUPS[0]?.id ?? '']: true });
  /** Raw text typed into a value box that isn't a usable colour yet. */
  let invalid = $state<Record<string, string>>({});
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const identity = captureVaultIdentity();
  let finished = false;
  let frame = 0;

  function takenIds(): string[] {
    return themeStore.available;
  }

  function paint(): void {
    frame = 0;
    if (finished) return;
    try {
      themeStore.preview({ id: initial.ownId ?? 'preview', name, base: initial.base, variables });
    } catch (err) {
      reportError('ThemeEditor.preview', err, "Couldn't preview the theme.");
    }
  }

  function schedulePaint(): void {
    if (frame) return;
    frame = requestAnimationFrame(paint);
  }

  paint();

  function setToken(token: string, value: string): void {
    const safe = asSafeThemeValue(value);
    if (safe === null) {
      invalid = { ...invalid, [token]: value };
      return;
    }
    const { [token]: _dropped, ...rest } = invalid;
    void _dropped;
    invalid = rest;
    variables = { ...variables, [token]: safe };
    schedulePaint();
  }

  function toggleGroup(id: string): void {
    openGroups = { ...openGroups, [id]: !openGroups[id] };
  }

  async function save(asNew: boolean): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot || busy) return;
    const ownId = asNew ? null : initial.ownId;
    problem = themeNameProblem(name, takenIds(), ownId);
    if (problem) return;
    const file = buildThemeFile(name, initial.base, variables);
    if (ownId) file.id = ownId;
    busy = true;
    try {
      const id = await themeStore.saveTheme(vaultRoot, file);
      if (!id || !isStillSameVault(identity)) return;
      finished = true;
      const applied = await themeStore.applyById(vaultRoot, id);
      if (applied.ok) {
        vaultStore.setTheme(id);
        await vaultStore.save();
      }
      uiStore.toast(`Theme "${file.name}" saved`, 'success');
      onclose();
    } catch (err) {
      reportError('ThemeEditor.save', err, "Couldn't save the theme");
    } finally {
      busy = false;
    }
  }

  async function cancel(): Promise<void> {
    finished = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const vaultRoot = vaultStore.path;
    if (vaultRoot && isStillSameVault(identity)) await themeStore.endPreview(vaultRoot);
    onclose();
  }

  onDestroy(() => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (finished) return;
    finished = true;
    // Settings closed, or the vault changed, with the preview still up: the
    // active theme comes back. A new vault paints its own theme.
    const vaultRoot = vaultStore.path;
    if (vaultRoot && isStillSameVault(identity)) void themeStore.endPreview(vaultRoot);
  });
</script>

<div class="theme-editor" aria-label="Theme editor">
  <header class="editor-header">
    <h3 class="section-title">{initial.mode === 'edit' ? 'Edit theme' : 'New theme'}</h3>
    <p class="editor-hint">
      Changes show as you make them. A theme holds colours only: fonts, sizes and the toolbar colour
      stay in General settings.
    </p>
  </header>

  <div class="name-row">
    <label class="setting-label" for="theme-editor-name">Name</label>
    <input
      id="theme-editor-name"
      class="text-input"
      type="text"
      maxlength={THEME_NAME_MAX}
      bind:value={name}
      oninput={() => (problem = null)}
      aria-invalid={problem !== null}
      aria-describedby={problem ? 'theme-editor-problem' : undefined}
    />
  </div>
  {#if problem}
    <p class="problem" id="theme-editor-problem" role="alert">{problem}</p>
  {/if}

  {#each THEME_TOKEN_GROUPS as group (group.id)}
    <section class="token-group">
      <button
        class="group-toggle"
        type="button"
        aria-expanded={openGroups[group.id] === true}
        onclick={() => toggleGroup(group.id)}
      >
        <svg class="chevron" class:open={openGroups[group.id]} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {group.label}
      </button>
      {#if openGroups[group.id]}
        <div class="token-rows">
          {#each group.tokens as token (token.name)}
            <div class="token-row">
              <span class="token-label" title={token.name}>{token.label}</span>
              <ColorPicker
                value={variables[token.name] ?? ''}
                allowAuto={false}
                onchange={(c) => setToken(token.name, c)}
              />
              <input
                class="text-input value-input"
                type="text"
                aria-label="{token.label} value"
                aria-invalid={token.name in invalid}
                value={invalid[token.name] ?? variables[token.name] ?? ''}
                onchange={(e) => setToken(token.name, e.currentTarget.value)}
              />
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/each}

  <footer class="editor-actions">
    <button class="btn-secondary" type="button" onclick={cancel} disabled={busy}>Cancel</button>
    {#if initial.mode === 'edit'}
      <button class="btn-secondary" type="button" onclick={() => save(true)} disabled={busy}>Save as new</button>
    {/if}
    <button class="btn-primary" type="button" onclick={() => save(false)} disabled={busy}>Save</button>
  </footer>
</div>

<style>
  .theme-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .editor-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    margin: 0;
    line-height: 1.5;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .setting-label {
    font-size: var(--font-size-base);
    font-weight: 500;
    color: var(--text-primary);
    flex-shrink: 0;
  }

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--modal-bg, var(--ui-surface));
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .text-input:focus {
    border-color: var(--ui-border-focus);
  }

  .text-input[aria-invalid='true'] {
    border-color: var(--accent-danger);
  }

  .problem {
    margin: 0;
    font-size: 12px;
    color: var(--accent-danger);
  }

  .token-group {
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .group-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: var(--ui-bg-secondary, var(--ui-surface));
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-weight: 600;
    font-family: var(--font-system);
    cursor: pointer;
    text-align: left;
  }

  .group-toggle:hover {
    background: var(--ui-surface-hover);
  }

  .chevron {
    transition: transform 0.15s ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .token-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
  }

  .token-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 9rem);
    align-items: center;
    gap: 8px;
  }

  .token-label {
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .value-input {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
  }

  .editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-primary {
    border: none;
    background: var(--accent-primary);
    color: var(--text-inverse);
  }

  .btn-secondary {
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>
