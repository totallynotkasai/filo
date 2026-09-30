<script lang="ts">
  /**
   * KanbanCard — wraps a Kanban placement's tile body with card-level chrome:
   * optional cover image strip (text cards only), and a footer carrying the
   * priority pill, checklist progress badge, and due-date badge.
   *
   * Priority and dueDate live in the backing `.md`'s YAML frontmatter (canonical
   * fields); reads go through `noteFrontmatter`, writes through the parent's
   * field commands to the note writer.
   *
   * Cover image is placement-level (not frontmatter) — a card-visual concern
   * that should not travel with the underlying file across boards. Stored on
   * the `KanbanTilePlacement` and rendered via the same `filo://` media URL
   * pipeline as `ImageTile`.
   */
  import { noteBody, noteFieldsKnown, noteFrontmatter } from '../../stores/noteMeta';
  import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { toMediaUrl } from '../../lib/utils/mediaUrl';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import type { Tile, TextTile, KanbanTilePlacement } from '../../schema/index';
  import type {
    ResolvedCardStyle,
    ResolvedTileStyle,
  } from '../../lib/styles/effectiveStyle';
  import { effectiveTileStyle } from '../../lib/styles/effectiveStyle';
  import { getContext, untrack } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import TileContainer from '../tiles/TileContainer.svelte';
  import LazyTextTileBody from '../tiles/LazyTextTileBody.svelte';
  import ImageTile from '../tiles/ImageTile.svelte';
  import AudioTile from '../tiles/AudioTile.svelte';
  import FileTile from '../tiles/FileTile.svelte';
  import LinkTile from '../tiles/LinkTile.svelte';
  import TagBadge from '../tags/TagBadge.svelte';
  import TagsPopupMenu from '../tags/TagsPopupMenu.svelte';
  import { portal } from '../../lib/utils/portal';
  import { FIELD_READERS, type Priority } from '../../lib/tasks/frontmatterReaders';
  import { PRIORITY_COLOR, PRIORITY_LABEL } from '../../constants/taskPriorities';
  import {
    formatDueDateAbsolute,
    isOverdue as isOverdueLib,
  } from '../../lib/tasks/dueDateFormat';
  import { clockStore } from '../../stores/clock.svelte';
  import { checklistProgress as countChecklist } from '../../lib/kanban/checklistProgress';

  // Per-pane scope so we can compose the tile cascade with the card
  // cascade's per-card fontSize overrides below.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let {
    tile,
    placement,
    cardStyle,
    onSetDueDate,
    onSetPriority,
    onPickCoverImage,
    onClearCoverImage,
    onOpenAsDocument,
  }: {
    tile: Tile;
    placement: KanbanTilePlacement;
    /** Cascade-resolved card chrome — background, border, shadow, DCT text
     *  colour, font sizes. Computed by <KanbanBoard>'s `resolveCardStyle`
     *  helper against this placement's `style` so per-card overrides win
     *  over board / global card defaults. */
    cardStyle: ResolvedCardStyle;
    onSetDueDate: (dueDate: string) => void;
    onSetPriority: (priority: Priority) => void;
    onPickCoverImage: () => void;
    onClearCoverImage: () => void;
    /** Opens this card's backing `.md` file as a Document board in a new tab.
     *  Wired up by the parent via `kanbanFrontmatterWriter.openTileAsDocument`.
     *  Only fires for text tiles; the double-click handler short-circuits
     *  on any other tile type. */
    onOpenAsDocument: () => void;
  } = $props();

  // Card-cascade-driven chrome. Border falls back to the theme border
  // colour when the cascade resolves no per-card border colour but does
  // resolve a positive width — matches the previous hand-merge behaviour.
  //
  // `backgroundColor` paints the OUTER shell — the "Background" zone where
  // the footer (priority pill, due-date chip, tag chips) lives. The card's
  // `headerColor` / `bodyColor` overlay on top of this via the inner
  // TileHeader / tile body, layered through `composedTileResolved` below.
  //
  // Shape (rounded vs rectangle) drives the shell's border-radius and
  // propagates into the inner tile container so the visual is consistent.
  let shellInlineStyle = $derived.by(() => {
    const parts: string[] = [];
    if (cardStyle.backgroundColor) parts.push(`background-color: ${cardStyle.backgroundColor}`);
    if (cardStyle.borderWidth > 0 && cardStyle.borderStyle) {
      parts.push(`border: ${cardStyle.borderWidth}px ${cardStyle.borderStyle} ${cardStyle.borderColor || 'var(--ui-border-light)'}`);
    }
    if (cardStyle.shadowIntensity > 0) {
      parts.push(
        `box-shadow: 0 2px ${8 * cardStyle.shadowIntensity}px rgba(0,0,0,${0.3 * cardStyle.shadowIntensity})`,
      );
    }
    // Shape override (default rounded = 8px to match the prior baked rule).
    parts.push(`border-radius: ${cardStyle.shape === 'rectangle' ? '0' : '8px'}`);
    // Dynamic Contrast Text — resolved text colour against the card's
    // background. `cardStyle.textColor` is `null` when DCT is off.
    if (cardStyle.textColor) parts.push(`color: ${cardStyle.textColor}`);
    return parts.join('; ');
  });

  // Compose the tile cascade with the card cascade's per-card overrides.
  // - headerColor / bodyColor: card-level overrides win over the tile's
  //   own (mindmap-context) colours, so the same .md file styled on a
  //   Mind Map can be re-coloured independently when shown as a Kanban
  //   card. Empty card overrides fall through to the tile's colour.
  // - shape: card-level shape propagates so the inner tile clip matches
  //   the shell (avoids a rounded inner pill inside a rectangle card).
  // - fontSizeTitle / fontSizeBody: card-level font sizes land on
  //   TileHeader / TextTile via TileContainer's `resolved` prop.
  const composedTileResolved = $derived.by<ResolvedTileStyle>(() => {
    const base = effectiveTileStyle(tile, vaultStore.project?.settings, boardStore.current);
    return {
      ...base,
      headerColor: cardStyle.headerColor || base.headerColor,
      bodyColor: cardStyle.bodyColor || base.bodyColor,
      shape: cardStyle.shape ?? base.shape,
      // DCT picks against the card-resolved fills when the card cascade
      // produced one. Falling through to base's pick keeps mindmap tiles
      // legible in their own context.
      headerTextColor: cardStyle.headerColor && cardStyle.headerTextColor ? cardStyle.headerTextColor : base.headerTextColor,
      bodyTextColor: cardStyle.bodyColor && cardStyle.bodyTextColor ? cardStyle.bodyTextColor : base.bodyTextColor,
      fontSizeTitle: cardStyle.fontSizeTitle ?? base.fontSizeTitle,
      fontSizeBody: cardStyle.fontSizeBody ?? base.fontSizeBody,
    };
  });

  // When General settings → Toggle Hover Buttons → Cards is Off, the footer
  // action buttons stay permanently visible.
  let forceShowButtons = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.cards === false,
  );

  const isText = $derived(tile.type === 'text');
  // The card's note path; `null` for a non-text card.
  let notePath = $derived(isText ? ((tile as Tile & { filePath?: string }).filePath ?? null) : null);

  // ── Frontmatter-derived state (priority, dueDate) ──
  // The live cache wins when present (covers in-flight optimistic edits);
  // otherwise the vault index, so external edits reflect in the badge live.
  let frontmatter = $derived(
    notePath ? (noteFrontmatter(notePath) as Record<string, unknown>) : ({} as Record<string, unknown>),
  );

  // Shown before the vault-open read reached its note: ask for it next.
  $effect(() => {
    const path = notePath;
    if (path && vaultIndexStore.isBuilding && !noteFieldsKnown(path)) untrack(() => vaultIndexStore.prioritize([path]));
  });

  let priority = $derived<Priority>(FIELD_READERS.priority(frontmatter));
  let dueDate = $derived<string>(FIELD_READERS.dueDate(frontmatter));

  // ── Checklist progress (TipTap TaskList round-trips to `- [ ]` / `- [x]`) ──
  // The open note's body when loaded (ticking a box in its editor refreshes
  // the badge without a disk round-trip), else the vault index's: a card
  // whose editor isn't mounted yet has no open note. Hides when total === 0.
  let checklistProgress = $derived(notePath ? countChecklist(noteBody(notePath)) : null);

  // ── Cover image ──
  let coverPath = $derived<string>(typeof placement.coverImage === 'string' ? placement.coverImage : '');
  let coverDisplaySrc = $derived(coverPath ? toMediaUrl(coverPath, vaultStore.path) : '');
  // Surface a fallback when the cover fails to load (broken/missing
  // vault path) instead of leaving the OS broken-image glyph in the strip.
  let coverFailed = $state(false);
  function handleCoverLoad() { coverFailed = false; }
  function handleCoverError() { coverFailed = true; }

  function isOverdue(): boolean {
    return isOverdueLib(dueDate, frontmatter.completed === true, clockStore.todayDate());
  }

  // The shared chip helpers (as TaskList). `now` is the clock store's day, so a
  // chip turns overdue (and gains its year) at midnight.
  function formatDueDate(iso: string): string {
    return formatDueDateAbsolute(iso, { now: clockStore.todayDate() });
  }

  // ── Due date popover ──
  let dueDateInput: HTMLInputElement | null = $state(null);
  let showDuePopover = $state(false);

  function toggleDuePopover(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.stopPropagation();
    showDuePopover = !showDuePopover;
    if (showDuePopover) {
      queueMicrotask(() => dueDateInput?.focus());
    }
  }

  function closeDuePopover() {
    showDuePopover = false;
  }

  function commitDueDate(value: string) {
    onSetDueDate(value);
    showDuePopover = false;
  }

  // ── Priority popover ──
  // Colours pull from `--priority-*` CSS vars so themes can override the
  // palette without component edits. The literal-string defaults that used
  // to live here drifted from theme-by-theme to "always look like dark-mode".
  const PRIORITY_OPTIONS: Array<{ key: Priority; label: string; color: string }> = [
    { key: 'urgent', label: 'Urgent', color: 'var(--priority-urgent)' },
    { key: 'high', label: 'High', color: 'var(--priority-high)' },
    { key: 'medium', label: 'Medium', color: 'var(--priority-medium)' },
    { key: 'low', label: 'Low', color: 'var(--priority-low)' },
    { key: 'none', label: 'No priority', color: 'var(--text-tertiary)' },
  ];

  function openPriorityMenu(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    uiStore.showContextMenu(
      rect.left,
      rect.bottom + 4,
      PRIORITY_OPTIONS.map((opt) => ({
        id: `prio-${opt.key}`,
        label: opt.label,
        action: () => onSetPriority(opt.key),
      })),
    );
  }

  function handleCoverClick(e: MouseEvent) {
    e.stopPropagation();
    if (coverPath) {
      onClearCoverImage();
    } else {
      onPickCoverImage();
    }
  }

  // Double-click anywhere on a text card's surface opens its backing `.md`
  // as a Document tab. Guards: skip when the target is an editable text
  // element (TipTap title / body — dblclick is its in-place edit gesture)
  // or an interactive child (button / link / input). Non-text tiles have no
  // backing document, so the gesture is a no-op on them.
  function handleDoubleClick(e: MouseEvent) {
    if (!isText) return;
    if (isEditableTextTarget(e.target)) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenAsDocument();
  }

  // Tag click → open TagsPopupMenu at cursor (mirrors TileContainer pattern).
  // stopPropagation prevents svelte-dnd-action from interpreting the click as
  // the start of a card drag.
  let tagPopup = $state<{ tagName: string; x: number; y: number } | null>(null);
  function handleTagClick(tagName: string, e: MouseEvent) {
    e.stopPropagation();
    if (tagPopup?.tagName === tagName) {
      tagPopup = null;
    } else {
      tagPopup = { tagName, x: e.clientX, y: e.clientY };
    }
  }
  function closeTagPopup() { tagPopup = null; }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="kanban-card-shell"
  class:has-cover={!!coverPath}
  class:force-show-buttons={forceShowButtons}
  style={shellInlineStyle}
  ondblclick={handleDoubleClick}
>
  {#if coverPath}
    <div class="kanban-card-cover">
      <img
        src={coverDisplaySrc}
        alt=""
        draggable="false"
        onload={handleCoverLoad}
        onerror={handleCoverError}
      />
      {#if coverFailed}
        <div class="cover-error" role="img" aria-label="Cover image could not be loaded">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
            <line x1="3" y1="3" x2="21" y2="21"/>
          </svg>
        </div>
      {/if}
      <button
        class="cover-action"
        onclick={handleCoverClick}
        title="Remove cover image"
        aria-label="Remove cover image"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  <TileContainer tile={tile} flowLayout={true} resolved={composedTileResolved}>
    {#if tile.type === 'text'}
      <LazyTextTileBody tile={tile as TextTile} resolved={composedTileResolved} />
    {:else if tile.type === 'image'}
      <ImageTile {tile} />
    {:else if tile.type === 'audio'}
      <AudioTile {tile} />
    {:else if tile.type === 'file'}
      <FileTile {tile} />
    {:else if tile.type === 'link'}
      <LinkTile {tile} />
    {/if}
  </TileContainer>

  {#if tagPopup}
    <div
      use:portal
      class="tag-popup-overlay"
      onclick={closeTagPopup}
      onkeydown={(e) => { if (e.key === 'Escape') closeTagPopup(); }}
      role="presentation"
    ></div>
    <div
      use:portal
      class="tag-popup-anchor"
      style="position: fixed; left: {tagPopup.x}px; top: {tagPopup.y}px; z-index: var(--z-tile-popup);"
    >
      <TagsPopupMenu tagName={tagPopup.tagName} onClose={closeTagPopup} />
    </div>
  {/if}

  {#if isText}
    <div class="kanban-card-footer">
      {#if tile.tags.length > 0}
        <ul class="kanban-card-tags" aria-label="Tags for {tile.title}">
          {#each tile.tags as name (name)}
            <li>
              <TagBadge tagName={name} size="sm" onClick={(e) => handleTagClick(name, e)} />
            </li>
          {/each}
        </ul>
      {/if}

      {#if checklistProgress}
        <span
          class="card-checklist"
          title="{checklistProgress.checked} of {checklistProgress.total} items checked"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          {checklistProgress.checked}/{checklistProgress.total}
        </span>
      {/if}

      <span class="footer-spacer"></span>

      <div class="card-due-wrapper">
        {#if dueDate}
          <button
            class="card-due card-due-clickable"
            class:overdue={isOverdue()}
            onclick={toggleDuePopover}
            title="Change due date"
            aria-label="Change due date"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {formatDueDate(dueDate)}
          </button>
        {:else}
          <button
            class="card-due-btn"
            onclick={toggleDuePopover}
            title="Set due date"
            aria-label="Set due date"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </button>
        {/if}

        {#if showDuePopover}
          <div
            class="due-popover"
            role="dialog"
            tabindex="-1"
            aria-label="Set due date"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => { if (e.key === 'Escape') closeDuePopover(); }}
          >
            <input
              bind:this={dueDateInput}
              type="date"
              value={dueDate}
              onchange={(e) => commitDueDate((e.currentTarget as HTMLInputElement).value)}
            />
            {#if dueDate}
              <button class="due-clear" onclick={() => commitDueDate('')}>Clear</button>
            {/if}
          </div>
        {/if}
      </div>

      <!-- DESIGN: dedicated card-level "Add Tags" button removed — tag editing
           is reachable from the TileHeader's Tags button (visible on hover /
           when "Hover Buttons → Cards" is Off), so duplicating it here was
           just extra footer chrome. -->

      {#if priority !== 'none'}
        <button
          class="card-priority"
          onclick={openPriorityMenu}
          title="Priority: {priority}"
          style:color={PRIORITY_COLOR[priority]}
        >
          {PRIORITY_LABEL[priority]}
        </button>
      {:else}
        <button
          class="card-priority card-priority-empty"
          onclick={openPriorityMenu}
          title="Set priority"
          aria-label="Set priority"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        </button>
      {/if}

      <button
        class="cover-toggle-btn"
        onclick={handleCoverClick}
        title={coverPath ? 'Remove cover image' : 'Add cover image'}
        aria-label={coverPath ? 'Remove cover image' : 'Add cover image'}
      >
        {#if coverPath}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="3" x2="21" y2="21" />
          </svg>
        {:else}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        {/if}
      </button>
    </div>
  {/if}
</div>

<svelte:window
  onclick={() => { if (showDuePopover) showDuePopover = false; }}
/>

<style>
  .kanban-card-shell {
    position: relative;
    /* border-radius is set inline from the card cascade's `shape` so
       Rectangle vs Rounded both round-trip through the popup; the
       inline value wins over any default declared here. */
    overflow: hidden;
    transition: transform 0.15s ease, box-shadow 0.2s ease;
    display: flex;
    flex-direction: column;
  }

  .kanban-card-shell:hover {
    transform: translateY(-1px);
    box-shadow: var(--ui-shadow);
  }

  /* In Kanban context, the card is dragged from anywhere on its surface
     (the parent `.tile-drop-zone` dndzone reads pointerdown after we
     stopped TileContainer from swallowing it). The title's `cursor: text`
     would suggest single-click-to-edit, which isn't true here — edit is
     dblclick-only. Override with `grab` so the affordance matches the
     interaction. The TipTap editor host (`tile-title-editor`) gets text
     back so the cursor is right while editing. */
  .kanban-card-shell :global(.tile-title) {
    cursor: grab;
  }
  .kanban-card-shell :global(.tile-title-editor) {
    cursor: text;
  }

  .kanban-card-cover {
    position: relative;
    width: 100%;
    height: 100px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.05);
  }

  .kanban-card-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .cover-error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ui-surface);
    color: var(--text-tertiary);
    pointer-events: none;
  }

  .cover-action {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  .kanban-card-cover:hover .cover-action,
  .kanban-card-shell:focus-within .cover-action {
    opacity: 1;
  }

  .cover-action:hover {
    background: rgba(0, 0, 0, 0.75);
  }

  .kanban-card-tags {
    list-style: none;
    margin: 0;
    padding: 0;
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--tag-row-gap);
    min-width: 0;
    flex: 0 1 auto;
  }

  .kanban-card-footer {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 8px;
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .footer-spacer {
    flex: 1;
  }

  .card-priority {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
    cursor: pointer;
    border: none;
    transition: background-color 0.15s ease;
  }

  .card-priority:hover {
    background: var(--ui-surface-active);
  }

  .card-priority-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    padding: 2px 0;
    color: var(--text-tertiary);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .kanban-card-shell:hover .card-priority-empty,
  .kanban-card-shell:focus-within .card-priority-empty {
    opacity: 1;
  }

  .card-checklist {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
  }

  .card-due-wrapper {
    position: relative;
  }

  .card-due {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
    border: 1px solid transparent;
    cursor: pointer;
  }

  .card-due-clickable:hover,
  .card-due-clickable:focus-visible {
    border-color: var(--ui-border);
  }

  .card-due.overdue {
    color: var(--accent-danger);
    background: var(--menu-danger-bg);
  }

  .card-due-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  .kanban-card-shell:hover .card-due-btn,
  .kanban-card-shell:focus-within .card-due-btn {
    opacity: 1;
  }

  .card-due-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .cover-toggle-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  /* `:focus-within` mirrors `:hover` so keyboard users see
     the due-date / cover / priority controls instead of tabbing into
     invisible buttons. Matches the TileHeader / TaskItem pattern. */
  .kanban-card-shell:hover .cover-toggle-btn,
  .kanban-card-shell:focus-within .cover-toggle-btn {
    opacity: 1;
  }

  .cover-toggle-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  /* When General settings → Toggle Hover Buttons → Cards is Off, the footer
     hover-revealed buttons stay permanently visible. */
  .kanban-card-shell.force-show-buttons .card-due-btn,
  .kanban-card-shell.force-show-buttons .cover-toggle-btn,
  .kanban-card-shell.force-show-buttons .card-priority-empty {
    opacity: 1;
  }

  .due-popover {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    padding: 8px;
    z-index: 20;
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 160px;
  }

  .due-popover input[type='date'] {
    flex: 1;
    padding: 4px 6px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: 12px;
  }

  .due-clear {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--accent-danger);
    font-size: 11px;
    cursor: pointer;
  }

  .due-clear:hover {
    background: var(--menu-danger-bg);
  }
</style>
