<script lang="ts">
  /**
   * KanbanTemplatePicker — picker shown when the user adds a card via
   * "From Template…" inside a Kanban column.
   *
   * Lists Markdown templates from the vault's `Templates/` folder, scoped to
   * those whose frontmatter declares `boardType: kanban` or omits the field
   * entirely (universal templates). Filtering is async because we read each
   * template's frontmatter from disk — results stream in as files resolve.
   *
   * Selection emits `(ref, content)` upstream so the caller can interpolate
   * the body, write the new `.md`, and add a placement to the target column.
   */
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import { vaultStore } from '../../stores/vault.svelte';
  import {
    collectTemplateRefs,
    defaultTemplatesFolder,
    parseTemplate,
    searchTemplates,
    templateMatchesBoardType,
    type TemplateContent,
    type TemplateRef,
  } from '../../lib/templates/templateService';

  let {
    open,
    boardType,
    onSelect,
    onClose,
  }: {
    open: boolean;
    boardType: string;
    onSelect: (ref: TemplateRef, content: TemplateContent, rawContent: string) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let loading = $state(false);
  let parsedByPath = $state<Record<string, { content: TemplateContent; raw: string }>>({});
  let cardEl = $state<HTMLDivElement | null>(null);
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let trap: FocusTrap | null = null;
  let previouslyFocused: HTMLElement | null = null;

  const mdRefs = $derived<TemplateRef[]>(
    collectTemplateRefs(vaultStore.rawTree, vaultStore.path, defaultTemplatesFolder()),
  );

  // Pre-parse every template's frontmatter (async) so we know which match the
  // active board type. Re-runs when the refs list changes (new files added,
  // vault re-opened). Keeps a parsed cache so re-opening the picker doesn't
  // re-read every file from disk.
  $effect(() => {
    if (!open) return;
    const root = vaultStore.path;
    if (!root) return;
    const refs = mdRefs;
    const known = parsedByPath;
    const missing = refs.filter((r) => !known[r.path]);
    if (missing.length === 0) return;
    loading = true;
    void (async () => {
      const next: Record<string, { content: TemplateContent; raw: string }> = { ...known };
      for (const ref of missing) {
        try {
          // allow-raw-read: a template's source text for the picker, not a note view
          const result = await window.filo.invoke('vault:read-file-text', root, ref.path);
          const raw = result.success ? result.content : '';
          next[ref.path] = { content: parseTemplate(ref, raw), raw };
        } catch {
          // Treat unreadable files as missing — they just won't appear.
        }
      }
      parsedByPath = next;
      loading = false;
    })();
  });

  const filteredRefs = $derived.by<TemplateRef[]>(() => {
    const haystack = searchTemplates(mdRefs, query);
    return haystack.filter((ref) => {
      const parsed = parsedByPath[ref.path];
      if (!parsed) return false;
      // Board templates have a fenced filo-board block — those create new
      // boards, not Kanban cards, so they're never valid here.
      if (parsed.content.boardJson) return false;
      return templateMatchesBoardType(parsed.content, boardType);
    });
  });

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('ktp-backdrop')) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function pick(ref: TemplateRef) {
    const parsed = parsedByPath[ref.path];
    if (!parsed) return;
    onSelect(ref, parsed.content, parsed.raw);
  }

  $effect(() => {
    if (open && cardEl && !trap) {
      previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
      trap = createFocusTrap(cardEl, {
        escapeDeactivates: false,
        clickOutsideDeactivates: false,
        allowOutsideClick: true,
        returnFocusOnDeactivate: false,
        initialFocus: () => searchInputEl ?? cardEl ?? false,
        preventScroll: true,
      });
      try {
        trap.activate();
      } catch {
        searchInputEl?.focus();
      }
    } else if (!open && trap) {
      safeDeactivateTrap(trap, { host: cardEl, name: 'KanbanTemplatePicker' });
      trap = null;
      const toRestore = previouslyFocused;
      previouslyFocused = null;
      // Defer to next microtask so the picker has time to unmount before
      // refocusing — otherwise focus-trap can fight us for the focus ring.
      if (toRestore && toRestore.isConnected) {
        queueMicrotask(() => {
          if (toRestore.isConnected) toRestore.focus();
        });
      }
    }
  });
</script>

{#if open}
  <div
    class="ktp-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Pick a Markdown template"
    tabindex="-1"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="ktp-card" bind:this={cardEl}>
      <div class="ktp-header">
        <h2 class="ktp-title">Pick a Template</h2>
        <button class="ktp-close" onclick={onClose} title="Close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <input
        class="ktp-search"
        type="text"
        placeholder="Search templates..."
        bind:value={query}
        bind:this={searchInputEl}
      />

      <div class="ktp-body">
        {#if mdRefs.length === 0}
          <p class="ktp-empty">
            No Markdown templates. Create <code>.md</code> files in the
            <code>Templates/</code> folder of your vault. Add
            <code>boardType: kanban</code> to a template's frontmatter to scope
            it to Kanban boards.
          </p>
        {:else if loading && filteredRefs.length === 0}
          <p class="ktp-empty">Loading templates…</p>
        {:else if filteredRefs.length === 0}
          <p class="ktp-empty">
            {query.trim()
              ? `No templates match "${query.trim()}".`
              : 'No templates available for this board type.'}
          </p>
        {:else}
          <div class="ktp-list" role="listbox" aria-label="Kanban-compatible templates">
            {#each filteredRefs as ref (ref.path)}
              {@const parsed = parsedByPath[ref.path]}
              <button
                class="ktp-row"
                type="button"
                role="option"
                aria-selected="false"
                onclick={() => pick(ref)}
              >
                <span class="ktp-row-name">{ref.name}</span>
                <span class="ktp-row-path">{ref.path}</span>
                {#if parsed?.content.boardType}
                  <span class="ktp-row-tag">{parsed.content.boardType}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ktp-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 1);
    background: var(--modal-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.12s ease;
  }

  .ktp-card {
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideUp 0.15s ease;
  }

  .ktp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ui-border-light);
  }

  .ktp-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .ktp-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .ktp-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .ktp-search {
    margin: 12px 16px 0;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
  }

  .ktp-search:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .ktp-search:focus:not(:focus-visible) {
    outline: none;
  }

  .ktp-body {
    padding: 12px 16px 16px;
    overflow-y: auto;
    flex: 1;
  }

  .ktp-empty {
    margin: 8px 0;
    padding: 12px 4px;
    font-size: var(--font-size-base);
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .ktp-empty code {
    font-family: ui-monospace, monospace;
    background: var(--ui-surface-hover);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .ktp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ktp-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.08s ease, border-color 0.08s ease;
  }

  .ktp-row:hover {
    background: var(--ui-surface-hover);
    border-color: var(--ui-border-light);
  }

  .ktp-row-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .ktp-row-path {
    font-size: 11px;
    color: var(--text-tertiary);
    font-family: ui-monospace, monospace;
  }

  .ktp-row-tag {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent-primary);
    background: var(--ui-surface-hover);
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 2px;
  }

</style>
