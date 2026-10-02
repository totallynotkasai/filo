<script lang="ts">
  import { searchStore, type ReplacedMatch, type SearchMode } from '../../stores/search.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { navigateToTile } from '../../lib/utils/navigation.svelte';
  import { openNoteInDocumentTab } from '../../lib/notes/openNote';
  import SearchFindAllPopup from './SearchFindAllPopup.svelte';
  import IconButton from '../shared/IconButton.svelte';
  import { replaceableMatches } from '../../lib/search/runSearch';
  import { replaceAllConfirmBody, searchedText, ONLY_SYNTAX_MATCHES, TOO_MANY_TO_REPLACE } from '../../lib/search/replaceAllText';

  /**
   * Vault-wide Search panel.
   *
   * Floating panel anchored to the top-left of the workspace. Rendered
   * inside AppShell so it overlays the active board / pane container.
   * Drag handle moves the panel; bounds are clamped to the viewport so a
   * misplaced panel can't escape off-screen.
   *
   * Replace is a sub-mode toggled via the bottom-right button. ESC closes
   * the panel; tabbing inside it is unconstrained (no modal trap) so the
   * user can Tab from the find box into the workspace and back without
   * fighting a forced cycle.
   */

  const FIND_HELP = 'Finds the text exactly as typed, spaces included.\n'
    + 'Filters: tag:#name, board:name, property:key=value, type:image, has:connections. '
    + 'With a filter, put text that has spaces in quotes.\n'
    + '/pattern/ finds a regular expression.';

  let panelEl = $state<HTMLElement | null>(null);
  let findInputEl = $state<HTMLInputElement | null>(null);
  let replaceInputEl = $state<HTMLInputElement | null>(null);

  let panelX = $state(16);
  let panelY = $state(72);
  let dragging = $state(false);
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  let findAllOpen = $state(false);
  // No focus trap: the panel is a floating overlay, not a modal. The user
  // must remain free to click the canvas behind it to verify a match
  // visually before pressing Replace. ESC closes the panel; Tab cycles
  // through the panel's own controls in DOM order without being forced
  // back into a modal cycle.

  $effect(() => {
    if (!searchStore.open) {
      findAllOpen = false;
      return;
    }
    // First render after open — focus the find input. Wait one microtask
    // so bind:this has populated.
    queueMicrotask(() => {
      if (findInputEl) {
        findInputEl.focus();
        findInputEl.select();
      }
    });
  });

  /**
   * Navigation effect — fires whenever `searchStore.pendingJump` is set
   * (by `next` / `previous` / `jumpTo`). Routes through the existing
   * `navigateToTile` helper which handles board-switching, viewport
   * centring, selection, and the 2 s highlight pulse.
   *
   * Body-match offset jumping inside the editor is a future polish item
   * — the spec says "highlight the tile", which `navigateToTile` already
   * delivers. Within-tile scroll-to-offset would require TipTap editor
   * access and is not implemented yet.
   */
  $effect(() => {
    const jump = searchStore.pendingJump;
    if (!jump) return;
    const m = jump.match;
    // A note on no board has no tile to show, so it opens as a document.
    if (m.tileId) navigateToTile(m.boardId, m.tileId);
    else if (m.filePath) openNoteInDocumentTab(m.filePath);
    searchStore.consumeJump();
  });

  function clampToViewport(): void {
    if (typeof window === 'undefined') return;
    const maxX = Math.max(0, window.innerWidth - 360);
    const maxY = Math.max(0, window.innerHeight - 80);
    panelX = Math.min(Math.max(0, panelX), maxX);
    panelY = Math.min(Math.max(0, panelY), maxY);
  }

  function handleDragStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    // A press on the close button is a click, not a drag: with the pointer
    // captured by the header, the browser sends the click to the header and
    // the button never sees it.
    if ((e.target as Element | null)?.closest('button')) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rect = (panelEl ?? target).getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    dragging = true;
  }

  function handleDragMove(e: PointerEvent): void {
    if (!dragging) return;
    panelX = e.clientX - dragOffsetX;
    panelY = e.clientY - dragOffsetY;
    clampToViewport();
  }

  function handleDragEnd(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const target = e.currentTarget as HTMLElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // pointer was already released elsewhere
    }
  }

  function handleClose(): void {
    searchStore.closePanel();
  }

  function toggleReplace(): void {
    const next: SearchMode = searchStore.mode === 'find' ? 'replace' : 'find';
    searchStore.setMode(next);
    if (next === 'replace') {
      queueMicrotask(() => replaceInputEl?.focus());
    }
  }

  function handleFindKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        searchStore.previous();
      } else {
        searchStore.next();
      }
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) {
        searchStore.previous();
      } else {
        searchStore.next();
      }
    }
  }

  function onPanelKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  }

  // Replace clicks run one after another: a second click while the first is
  // still writing acts on the match the first moves on to, not on the one
  // it is replacing.
  let replaceQueue: Promise<void> = Promise.resolve();

  function handleReplaceCurrent(): Promise<void> {
    const run = replaceQueue.then(async () => {
      const replaced = await runReplaceCurrent();
      if (replaced) searchStore.showMatchAfterReplace(replaced);
    });
    // A Replace that throws still lets the next click run.
    replaceQueue = run.catch(() => undefined);
    return run;
  }

  async function handleReplaceAll(): Promise<void> {
    const found = searchStore.searchNow();
    if (found.truncated) {
      uiStore.toast(TOO_MANY_TO_REPLACE, 'warning', 4000);
      return;
    }
    const { count, files, inSyntax } = replaceableMatches(found.matches);
    if (count === 0) {
      uiStore.toast(
        found.matches.length === 0
          ? 'No matches to replace.'
          : inSyntax > 0 ? ONLY_SYNTAX_MATCHES : 'Only title matches found; Replace All leaves titles alone.',
        'info',
        inSyntax > 0 ? 5000 : 3000,
      );
      return;
    }
    uiStore.openConfirm({
      title: 'Replace All',
      body: replaceAllConfirmBody({
        find: searchedText(searchStore.parsed),
        replace: searchStore.replaceText,
        count,
        files,
        titleMatches: found.matches.length - count - inSyntax,
        inSyntax,
      }),
      confirmLabel: 'Replace All',
      danger: false,
      onConfirm: () => {
        void runReplaceAll();
      },
    });
  }

  // Lazy-import to keep the panel's initial render light and avoid a
  // circular reference at module-load time (the command imports stores
  // that may load this component lazily).
  async function runReplaceCurrent(): Promise<ReplacedMatch | null> {
    const { replaceCurrentMatch } = await import('../../commands/replaceAllCommand');
    return replaceCurrentMatch();
  }

  async function runReplaceAll(): Promise<void> {
    const { runReplaceAllCommand } = await import('../../commands/replaceAllCommand');
    await runReplaceAllCommand();
    // The replaced matches leave the list now, not once edits pause.
    searchStore.refreshNow();
  }

  // No onDestroy cleanup needed — the panel is renderer-light and the
  // store's vault-swap reset handles lifecycle teardown.
</script>

{#if searchStore.open}
  <!-- The role="search" landmark captures bubbled Escape so any focused
       child can close the panel via the same handler. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    class="search-panel"
    role="search"
    aria-label="Vault search"
    bind:this={panelEl}
    style="left: {panelX}px; top: {panelY}px;"
    onkeydown={onPanelKeydown}
  >
    <!-- Drag handle uses pointer events for repositioning. Adding
         role="toolbar" would mislead screen readers (no inner buttons). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header
      class="drag-handle"
      aria-label="Drag to move panel"
      onpointerdown={handleDragStart}
      onpointermove={handleDragMove}
      onpointerup={handleDragEnd}
      onpointercancel={handleDragEnd}
    >
      <span class="drag-grip" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="4" cy="4" r="0.8" fill="currentColor"/>
          <circle cx="10" cy="4" r="0.8" fill="currentColor"/>
          <circle cx="4" cy="10" r="0.8" fill="currentColor"/>
          <circle cx="10" cy="10" r="0.8" fill="currentColor"/>
        </svg>
      </span>
      <span class="title">Search</span>
      <span class="result-count" aria-live="polite">
        {#if searchStore.matches.length === 0}
          {searchStore.query.length > 0 ? 'No results' : ''}
        {:else}
          {searchStore.currentIndex + 1} / {searchStore.matches.length}
          {#if searchStore.truncated}
            <span class="truncated" title="Result list is capped — refine your query for more">+</span>
          {/if}
        {/if}
      </span>
      <button
        type="button"
        class="close-btn"
        onclick={handleClose}
        aria-label="Close search"
        title="Close (Esc)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </header>

    <div class="row">
      <label class="visually-hidden" for="search-find-input">Find</label>
      <input
        id="search-find-input"
        type="search"
        class="search-input"
        placeholder="Find in vault… (tag:#name property:k=v type:image /regex/)"
        title={FIND_HELP}
        value={searchStore.query}
        oninput={(e) => searchStore.setQuery((e.currentTarget as HTMLInputElement).value)}
        onkeydown={handleFindKeydown}
        bind:this={findInputEl}
        autocomplete="off"
        spellcheck="false"
      />
      <div class="button-group" role="group" aria-label="Find actions">
        <IconButton
          ariaLabel="Previous match"
          title="Previous match (Shift+Enter)"
          onclick={() => searchStore.previous()}
          disabled={searchStore.matches.length === 0}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </IconButton>
        <IconButton
          ariaLabel="Next match"
          title="Next match (Enter)"
          onclick={() => searchStore.next()}
          disabled={searchStore.matches.length === 0}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </IconButton>
        <button
          type="button"
          class="text-btn"
          onclick={() => (findAllOpen = true)}
          disabled={searchStore.matches.length === 0}
        >
          Find All
        </button>
        <button
          type="button"
          class="text-btn toggle"
          aria-pressed={searchStore.mode === 'replace'}
          onclick={toggleReplace}
        >
          Replace
        </button>
      </div>
    </div>

    <div class="row options" role="group" aria-label="Match options">
      <label class="option" title="Match upper and lower case exactly (not for a /regex/)">
        <input
          type="checkbox"
          checked={searchStore.matchCase}
          onchange={(e) => searchStore.setMatchCase((e.currentTarget as HTMLInputElement).checked)}
        />
        Match case
      </label>
      <label class="option" title="Only whole words: 'cat' doesn't find 'concatenate' (not for a /regex/)">
        <input
          type="checkbox"
          checked={searchStore.wholeWord}
          onchange={(e) => searchStore.setWholeWord((e.currentTarget as HTMLInputElement).checked)}
        />
        Whole word
      </label>
    </div>

    {#if searchStore.mode === 'replace'}
      <div class="row">
        <label class="visually-hidden" for="search-replace-input">Replace</label>
        <input
          id="search-replace-input"
          type="text"
          class="search-input"
          placeholder="Replace with…"
          value={searchStore.replaceText}
          oninput={(e) => searchStore.setReplaceText((e.currentTarget as HTMLInputElement).value)}
          bind:this={replaceInputEl}
          autocomplete="off"
          spellcheck="false"
        />
        <div class="button-group" role="group" aria-label="Replace actions">
          <button
            type="button"
            class="text-btn"
            onclick={() => void handleReplaceCurrent()}
            disabled={searchStore.matches.length === 0 || searchStore.currentMatch?.matchKind !== 'body'}
          >
            Replace
          </button>
          <button
            type="button"
            class="text-btn danger"
            onclick={() => void handleReplaceAll()}
            disabled={searchStore.matches.length === 0 || searchStore.truncated}
            title={searchStore.truncated ? TOO_MANY_TO_REPLACE : undefined}
          >
            Replace All
          </button>
        </div>
      </div>
      {#if searchStore.truncated}
        <p class="replace-note" role="note">{TOO_MANY_TO_REPLACE}</p>
      {/if}
    {/if}
  </section>

  {#if findAllOpen}
    <SearchFindAllPopup onclose={() => (findAllOpen = false)} />
  {/if}
{/if}

<style>
  .search-panel {
    position: fixed;
    z-index: var(--z-floating);
    width: 360px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    box-shadow: var(--ui-shadow-md, 0 4px 16px rgba(0, 0, 0, 0.18));
    display: flex;
    flex-direction: column;
    font-family: var(--font-system);
    color: var(--text-primary);
  }

  .drag-handle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 10px;
    border-bottom: 1px solid var(--ui-border);
    cursor: grab;
    user-select: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .drag-grip {
    display: inline-flex;
    color: var(--text-tertiary);
  }

  .title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .result-count {
    flex: 1;
    text-align: right;
    font-size: 11px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .truncated {
    color: var(--text-secondary);
    font-weight: 700;
    margin-left: 2px;
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
  }

  .close-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
  }

  .row + .row {
    padding-top: 0;
  }

  .row.options {
    gap: 14px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .option {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .option input {
    margin: 0;
    accent-color: var(--accent-primary);
  }

  .replace-note {
    margin: 0;
    padding: 0 10px 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-system);
  }

  .search-input:focus {
    outline: 2px solid var(--accent-primary);
    outline-offset: -1px;
    border-color: var(--accent-primary);
  }

  .button-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .text-btn {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    font-family: var(--font-system);
  }

  .text-btn:hover:not(:disabled) {
    background: var(--ui-surface-hover);
  }

  .text-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .text-btn.toggle[aria-pressed="true"] {
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-color: var(--accent-primary);
  }

  .text-btn.danger:hover:not(:disabled) {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .search-panel {
      transition: none;
    }
  }
</style>
