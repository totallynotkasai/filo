<script lang="ts">
  /**
   * ThemeEditor — edits a theme's colours with a live preview.
   *
   * Every change paints at once (`themeStore.preview`), coalesced to one
   * paint per frame while a colour wheel is dragged. Save writes the file and
   * picks it the way a click on it would (`selectTheme`); Cancel, closing
   * Settings or leaving the vault paints the active theme again, so an unsaved
   * preview never sticks. Switching tab or closing Settings with changes asks
   * first (`themeEditorGuard.ts`).
   */
  import { onDestroy, untrack } from 'svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { THEME_TOKEN_GROUPS, TRANSLUCENT_TOKENS } from '../../lib/themes/themeTokens';
  import { selectTheme } from '../../lib/themes/themeActions';
  import { registerThemeEditor } from '../../lib/themes/themeEditorGuard';
  import {
    buildThemeFile,
    themeNameProblem,
    THEME_NAME_MAX,
    type ThemeEditorSession,
  } from '../../lib/themes/themeFiles';
  import { asSafeThemeValue } from '../../../shared/untrusted';
  import { isCssColour } from '../../lib/utils/color';
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
    // Every row here is a colour: a value the sanitiser passes but CSS can't
    // read as one (a mistyped `#12`) would save and then paint nothing.
    const safe = asSafeThemeValue(value);
    if (safe === null || !isCssColour(safe)) {
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

  const TOKEN_LABELS: Record<string, string> = Object.fromEntries(
    THEME_TOKEN_GROUPS.flatMap((g) => g.tokens.map((tk) => [tk.name, tk.label])),
  );

  /** Why the colours can't be saved yet: a value box holding a non-colour. */
  function colourProblem(): string | null {
    const bad = Object.keys(invalid).map((tk) => `"${TOKEN_LABELS[tk] ?? tk}"`);
    if (bad.length === 0) return null;
    return `${bad.join(', ')} ${bad.length === 1 ? "isn't a colour" : "aren't colours"} Filo can use. Fix ${bad.length === 1 ? 'it' : 'them'} or pick a colour before saving.`;
  }

  function isDirty(): boolean {
    if (name !== initial.name || Object.keys(invalid).length > 0) return true;
    const keys = new Set([...Object.keys(variables), ...Object.keys(initial.variables)]);
    for (const key of keys) if (variables[key] !== initial.variables[key]) return true;
    return false;
  }

  /** Saves; resolves false when nothing was saved (a problem is shown). */
  async function save(asNew: boolean): Promise<boolean> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot || busy) return false;
    const ownId = asNew ? null : initial.ownId;
    problem = colourProblem() ?? themeNameProblem(name, takenIds(), ownId);
    if (problem) return false;
    const file = buildThemeFile(name, initial.base, variables);
    if (ownId) file.id = ownId;
    busy = true;
    try {
      const id = await themeStore.saveTheme(vaultRoot, file);
      if (!id || !isStillSameVault(identity)) return false;
      finished = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // Picked as a click on it would: the Global Defaults colours prompt,
      // and in "System colours only" a look for this session only.
      const picked = await selectTheme(id);
      if (!picked && isStillSameVault(identity)) await themeStore.endPreview(vaultRoot);
      uiStore.toast(`Theme "${file.name}" saved`, 'success');
      onclose();
      return true;
    } catch (err) {
      reportError('ThemeEditor.save', err, "Couldn't save the theme");
      return false;
    } finally {
      busy = false;
    }
  }

  const unregister = registerThemeEditor({ name: () => name, isDirty, save: () => save(false) });

  async function cancel(): Promise<void> {
    finished = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const vaultRoot = vaultStore.path;
    if (vaultRoot && isStillSameVault(identity)) await themeStore.endPreview(vaultRoot);
    onclose();
  }

  onDestroy(() => {
    unregister();
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
                ariaLabel="{token.label} colour"
                showAlpha={TRANSLUCENT_TOKENS.has(token.name)}
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
