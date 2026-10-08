<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { canvasStore } from '../../stores/canvas.svelte';
  import { selectionStore } from '../../stores/selection.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { templatesStore } from '../../stores/templates.svelte';
  import { createTile } from '../../stores/tiles.svelte';
  import { instantiateLayoutTemplate } from '../../lib/templates/layoutCapture';
  import { getActiveContentFolder } from '../../lib/vault/conventionPaths';
  import { createNoteFile } from '../../lib/notes/createNote';
  import { noteMadeForNewItem } from '../../lib/notes/madeForNewItems';
  import { centreIn, placeClear, tileRects } from '../../lib/canvas/newTilePlacement';
  import { newTileView } from '../../lib/canvas/newTileView';
  import { reportError } from '../../lib/utils/errorBus';
  import { createBoardFromTemplate } from '../../lib/templates/boardFromTemplate';
  import { noteFromTemplate } from '../../lib/templates/templateNote';
  import {
    collectTemplateRefs,
    defaultTemplatesFolder,
    parseTemplate,
    searchTemplates,
    type TemplateContent,
    type TemplateRef,
  } from '../../lib/templates/templateService';
  import type { LayoutTemplate } from '../../schema/index';
  import type { LayoutTemplateRecord } from '../../lib/templates/layoutTemplateStore';
  import { plural } from '../../lib/utils/plural';

  /**
   * Unified Template Browser. Two sections:
   *   1. Layout Templates — saved structure (type/size/position/style) of a
   *      tile selection. Stored as `.filo/templates/*.template.json`.
   *   2. Markdown Templates — `.md` files in the vault's `Templates/`
   *      folder with `{{title}}` / `{{date}}` substitution. One with a
   *      ```filo-board``` block makes a new board; any other becomes a note
   *      and a tile on the canvas.
   *
   * Over a Mind Map it lists both. Anywhere else (a Kanban board, a Task
   * List, a Document tab, no tab), and when opened for a new board (the New
   * Tab menu), it lists only the board templates: nothing else has a canvas
   * to go on.
   *
   * Insertion anchor for layout templates comes from
   * `templatesStore.pendingInsertAnchor` when the browser was opened from
   * the canvas right-click, otherwise the viewport centre minus half the
   * template's bounding box (keeps the layout centred).
   */

  let query = $state('');
  let renaming = $state<string | null>(null);
  let renameDraft = $state('');
  let renameError = $state<string | null>(null);
  let confirmingDelete = $state<string | null>(null);
  /** Each Markdown template as read, by path (whether it makes a board is in its text). */
  let parsedByPath = $state<Record<string, TemplateContent>>({});
  let reading = $state(false);

  const isOpen = $derived(uiStore.isModalOpen('template-picker'));
  /** Layout and note templates go on this canvas; anywhere else only board templates are listed. */
  const onCanvas = $derived(!templatesStore.newBoardOnly && boardStore.current?.type === 'mindmap');

  $effect(() => {
    if (isOpen) {
      query = '';
      renaming = null;
      confirmingDelete = null;
      void templatesStore.load();
    }
  });

  // ── Layout templates filtering ──
  const layoutRecords = $derived<LayoutTemplateRecord[]>(templatesStore.records);
  const filteredLayouts: LayoutTemplateRecord[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return layoutRecords;
    return layoutRecords.filter((r) => r.template.name.toLowerCase().includes(q));
  });

  // ── Markdown templates ──
  const mdRefs = $derived<TemplateRef[]>(
    collectTemplateRefs(vaultStore.rawTree, vaultStore.path, defaultTemplatesFolder()),
  );
  /** Each template once read: named by its `title:` when it has one, and whether it makes a board. */
  const readMdRefs = $derived<TemplateRef[]>(mdRefs.map((ref) => parsedByPath[ref.path]?.ref ?? ref));
  const listedMdRefs = $derived<TemplateRef[]>(onCanvas ? readMdRefs : readMdRefs.filter((ref) => ref.isBoard));
  const filteredMdRefs = $derived<TemplateRef[]>(searchTemplates(listedMdRefs, query));

  async function loadMdRaw(ref: TemplateRef): Promise<string | null> {
    const root = vaultStore.path;
    if (!root) return null;
    try {
      // allow-raw-read: a template's source text for the browser, not a note view
      const result = await window.filo.invoke('vault:read-file-text', root, ref.path);
      if (result.success) return result.content;
      return null;
    } catch {
      return null;
    }
  }

  // Each template is read once the browser opens, so the board templates can
  // be told from the others (and marked) before one is picked.
  $effect(() => {
    if (!isOpen) return;
    const missing = mdRefs.filter((r) => !parsedByPath[r.path]);
    if (missing.length === 0) return;
    reading = true;
    void (async () => {
      const next: Record<string, TemplateContent> = { ...parsedByPath };
      for (const ref of missing) {
        const raw = await loadMdRaw(ref);
        if (raw !== null) next[ref.path] = parseTemplate(ref, raw);
      }
      parsedByPath = next;
      reading = false;
    })();
  });

  function computeAnchor(template: LayoutTemplate): { x: number; y: number } {
    const stored = templatesStore.consumePendingInsertAnchor();
    if (stored) return stored;
    const vp = canvasStore.viewportRect;
    return {
      x: vp.left + vp.width / 2 - template.boundingBox.width / 2,
      y: vp.top + vp.height / 2 - template.boundingBox.height / 2,
    };
  }

  function pickLayout(record: LayoutTemplateRecord): void {
    const board = boardStore.current;
    if (!board) {
      uiStore.toast('Open a board to insert a template', 'warning');
      uiStore.closeModal();
      return;
    }
    const anchor = computeAnchor(record.template);
    const existingTitles = Object.values(boardStore.tiles).map((t) => t.title);
    const { tiles, connections, sharedNotes } = instantiateLayoutTemplate(record.template, {
      anchor,
      boardId: board.id,
      createTile,
      existingTitles,
    });
    boardStore.addTilesAndConnectionsWithHistory(
      tiles,
      connections,
      `Insert template "${record.template.name}"`,
      sharedNotes,
    );
    selectionStore.clear();
    selectionStore.selectMultiple(tiles.map((t) => t.id));
    uiStore.toast(`Inserted template "${record.template.name}"`, 'success', 1800);
    uiStore.closeModal();
  }

  async function pickMarkdown(ref: TemplateRef): Promise<void> {
    // Read again: the file may have changed since the list was read.
    const raw = await loadMdRaw(ref);
    if (raw === null) {
      uiStore.toast(`Failed to load template: ${ref.name}`, 'error');
      return;
    }
    const content = parseTemplate(ref, raw);

    if (content.ref.isBoard) {
      // A failure has already said why.
      const created = await createBoardFromTemplate(content.ref, content);
      if (!created) return;
      tabStore.open(created.id, created.name, created.type, created.emoji ?? '');
      uiStore.toast(`Created board "${created.name}"`, 'success', 1800);
      uiStore.closeModal();
      return;
    }

    const board = boardStore.current;
    const vaultRoot = vaultStore.path;
    if (!onCanvas || !board || !vaultRoot) {
      uiStore.toast(`"${ref.name}" makes a note, not a board: open a Mind Map to put it on the canvas.`, 'info', 5000);
      return;
    }
    // The same note every board makes from a template: its frontmatter kept
    // and filled in, then a tile for it, clear of the tiles in the view.
    const note = noteFromTemplate(content, ref.name);
    let relPath: string;
    let written: string;
    try {
      ({ relPath, content: written } = await createNoteFile({ vaultRoot, folder: getActiveContentFolder(board), title: note.title, frontmatter: note.frontmatter, body: note.body }));
    } catch (err) {
      reportError('TemplateBrowser.markdown', err, `Couldn't make a note from template "${ref.name}"`);
      return;
    }
    noteMadeForNewItem(relPath, written);
    const view = newTileView(canvasStore);
    const tile = createTile('text', { x: 0, y: 0 }, board.id, { title: note.title, filePath: relPath } as never);
    const wanted = templatesStore.consumePendingInsertAnchor() ?? centreIn(view, tile.size);
    tile.position = { ...tile.position, ...placeClear(wanted, tile.size, tileRects(boardStore.tiles), view) };
    boardStore.addTileWithHistory(tile);
    selectionStore.select(tile.id);
    uiStore.toast(`Inserted template "${ref.name}"`, 'success', 1800);
    uiStore.closeModal();
  }

  function startRename(id: string, currentName: string): void {
    renaming = id;
    renameDraft = currentName;
    renameError = null;
  }

  async function commitRename(id: string): Promise<void> {
    const next = renameDraft.trim();
    if (!next) {
      renameError = 'Name cannot be empty.';
      return;
    }
    if (templatesStore.hasName(next, id)) {
      renameError = `A template named "${next}" already exists.`;
      return;
    }
    try {
      await templatesStore.rename(id, next);
      renaming = null;
      renameError = null;
    } catch (err) {
      renameError = err instanceof Error ? err.message : String(err);
    }
  }

  function cancelRename(): void {
    renaming = null;
    renameError = null;
  }

  async function confirmDelete(id: string): Promise<void> {
    try {
      await templatesStore.delete(id);
      confirmingDelete = null;
    } catch (err) {
      uiStore.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  // ── SVG preview helpers ──

  const PREVIEW_WIDTH = 200;
  const PREVIEW_HEIGHT = 130;
  const PREVIEW_PADDING = 8;

  interface PreviewRect {
    x: number;
    y: number;
    w: number;
    h: number;
    headerColor: string;
    bodyColor: string;
    borderColor: string;
    rx: number;
    borderWidth: number;
    borderStyle: 'solid' | 'dashed' | 'dotted';
  }

  function previewRects(template: LayoutTemplate): PreviewRect[] {
    if (template.tiles.length === 0) return [];
    const bw = template.boundingBox.width || 1;
    const bh = template.boundingBox.height || 1;
    const innerW = PREVIEW_WIDTH - PREVIEW_PADDING * 2;
    const innerH = PREVIEW_HEIGHT - PREVIEW_PADDING * 2;
    const scale = Math.min(innerW / bw, innerH / bh);
    const offsetX = (PREVIEW_WIDTH - bw * scale) / 2;
    const offsetY = (PREVIEW_HEIGHT - bh * scale) / 2;
    return template.tiles.map((t) => ({
      x: offsetX + t.relativePosition.x * scale,
      y: offsetY + t.relativePosition.y * scale,
      w: Math.max(2, t.size.width * scale),
      h: Math.max(2, t.size.height * scale),
      headerColor: t.style.headerColor || '#888',
      bodyColor: t.style.bodyColor || '#eee',
      borderColor: t.style.borderColor || 'transparent',
      rx: t.style.shape === 'rounded' ? 3 : 0,
      borderWidth: Math.max(0, Math.min(2, t.style.borderWidth ?? 1)),
      borderStyle: t.style.borderStyle ?? 'solid',
    }));
  }

  function headerBandHeight(rect: PreviewRect): number {
    return Math.min(rect.h * 0.25, 6);
  }
</script>

<Modal id="template-picker" title={templatesStore.newBoardOnly ? 'New Board from Template' : 'Templates'} width="720px">
  <div class="browser">
    <input
      class="search-input"
      type="text"
      placeholder="Search templates..."
      aria-label="Search templates"
      bind:value={query}
    />

    <!-- ── Layout Templates ── -->
    {#if onCanvas}
    <section class="section">
      <header class="section-header">
        <h3 class="section-title">Layout Templates</h3>
        <span class="section-count">{filteredLayouts.length}</span>
      </header>

      {#if !templatesStore.loaded && templatesStore.loading}
        <p class="empty-hint">Loading…</p>
      {:else if layoutRecords.length === 0}
        <p class="empty-hint">
          No layout templates yet. Select one or more tiles on a Mind Map board,
          right-click, and choose <strong>Save as Template</strong>.
        </p>
      {:else if filteredLayouts.length === 0}
        <p class="empty-hint">No layout templates match "{query}".</p>
      {:else}
        <div class="layout-grid">
          {#each filteredLayouts as record (record.template.id)}
            <div class="layout-card" class:editing={renaming === record.template.id}>
              <button
                class="layout-preview"
                type="button"
                onclick={() => pickLayout(record)}
                title="Insert this template"
                aria-label={`Insert template ${record.template.name}`}
              >
                <svg
                  viewBox="0 0 {PREVIEW_WIDTH} {PREVIEW_HEIGHT}"
                  width={PREVIEW_WIDTH}
                  height={PREVIEW_HEIGHT}
                  preserveAspectRatio="xMidYMid meet"
                 aria-hidden="true">
                  {#each previewRects(record.template) as r, i (i)}
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      rx={r.rx}
                      ry={r.rx}
                      fill={r.bodyColor}
                      stroke={r.borderColor}
                      stroke-width={r.borderWidth}
                      stroke-dasharray={r.borderStyle === 'dashed' ? '3 2' : r.borderStyle === 'dotted' ? '1 2' : undefined}
                    />
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={headerBandHeight(r)}
                      rx={r.rx}
                      ry={r.rx}
                      fill={r.headerColor}
                    />
                  {/each}
                </svg>
              </button>

              <div class="layout-meta">
                {#if renaming === record.template.id}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="rename-input"
                    type="text"
                    bind:value={renameDraft}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitRename(record.template.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onblur={() => void commitRename(record.template.id)}
                    autofocus
                  />
                {:else}
                  <span class="layout-name" title={record.template.name}>
                    {record.template.name}
                  </span>
                {/if}
                <span class="layout-info">{plural(record.template.tiles.length, 'tile')}</span>
              </div>

              {#if renameError && renaming === record.template.id}
                <p class="rename-error" role="alert">{renameError}</p>
              {/if}

              <div class="layout-actions">
                <button
                  class="action-btn"
                  type="button"
                  onclick={() => startRename(record.template.id, record.template.name)}
                  title="Rename"
                  aria-label="Rename template"
                >
                  Rename
                </button>
                <button
                  class="action-btn danger"
                  type="button"
                  onclick={() => (confirmingDelete = record.template.id)}
                  title="Delete"
                  aria-label="Delete template"
                >
                  Delete
                </button>
              </div>

              {#if confirmingDelete === record.template.id}
                <div class="confirm-popover" role="alertdialog" aria-label="Confirm delete">
                  <p>Delete template "{record.template.name}"?</p>
                  <div class="confirm-actions">
                    <button type="button" onclick={() => (confirmingDelete = null)}>Cancel</button>
                    <button type="button" class="danger" onclick={() => void confirmDelete(record.template.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
    {/if}

    <!-- ── Markdown Templates (board templates only, off a Mind Map) ── -->
    <section class="section">
      <header class="section-header">
        <h3 class="section-title">{onCanvas ? 'Markdown Templates' : 'Board Templates'}</h3>
        <span class="section-count">{filteredMdRefs.length}</span>
      </header>

      {#if onCanvas && mdRefs.length === 0}
        <p class="empty-hint">
          No Markdown templates. Create <code>.md</code> files inside the
          <code>Templates/</code> folder of your vault to use them here.
          Supports <code>{`{{title}}`}</code>, <code>{`{{date}}`}</code>,
          <code>{`{{time}}`}</code>, <code>{`{{datetime}}`}</code>,
          <code>{`{{year}}`}</code>, <code>{`{{month}}`}</code> and
          <code>{`{{day}}`}</code> placeholders.
        </p>
      {:else if !onCanvas && listedMdRefs.length === 0}
        <p class="empty-hint">
          {#if reading}
            Loading…
          {:else}
            No board templates. A board template is a <code>.md</code> file in
            the <code>Templates/</code> folder of your vault with a
            <code>```filo-board```</code> block that describes the board.
            Templates for notes and layouts go on a Mind Map's canvas.
          {/if}
        </p>
      {:else if filteredMdRefs.length === 0}
        <p class="empty-hint">No {onCanvas ? 'Markdown' : 'board'} templates match "{query}".</p>
      {:else}
        <ul class="md-list" aria-label={onCanvas ? 'Markdown templates' : 'Board templates'}>
          {#each filteredMdRefs as ref (ref.path)}
            <li>
              <button
                class="md-row"
                type="button"
                onclick={() => void pickMarkdown(ref)}
              >
                <span class="md-name">
                  {ref.name}
                  {#if onCanvas && ref.isBoard}
                    <span class="md-kind">Makes a board</span>
                  {/if}
                </span>
                <span class="md-path">{ref.path}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</Modal>

<style>
  .browser {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 320px;
  }

  .search-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
  }

  .search-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .search-input:focus:not(:focus-visible) {
    outline: none;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--ui-border);
  }

  .section-title {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .section-count {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .empty-hint {
    color: var(--text-tertiary);
    font-size: var(--font-size-base);
    line-height: 1.5;
    margin: 0;
    padding: 12px 4px;
  }

  .empty-hint code {
    font-family: ui-monospace, monospace;
    background: var(--ui-surface-hover);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .layout-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .layout-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--ui-surface, var(--ui-bg));
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .layout-card:hover {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .layout-preview {
    display: block;
    width: 100%;
    padding: 0;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
    overflow: hidden;
  }

  .layout-preview svg {
    display: block;
    width: 100%;
    height: auto;
  }

  .layout-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .layout-name {
    font-size: var(--font-size-base);
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .layout-info {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .rename-input {
    width: 100%;
    padding: 4px 8px;
    font-size: var(--font-size-base);
    color: var(--text-primary);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border-focus, var(--accent-primary));
    border-radius: 4px;
  }

  .rename-input:focus:not(:focus-visible) {
    outline: none;
  }

  .rename-error {
    margin: 0;
    font-size: 11px;
    color: var(--accent-danger);
  }

  .layout-actions {
    display: flex;
    gap: 4px;
  }

  .action-btn {
    flex: 1;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease;
  }

  .action-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .action-btn.danger:hover {
    color: var(--accent-danger);
    border-color: var(--accent-danger);
  }

  .confirm-popover {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: var(--modal-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    text-align: center;
    box-shadow: var(--ui-shadow-lg);
  }

  .confirm-popover p {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--text-primary);
  }

  .confirm-actions {
    display: flex;
    gap: 8px;
  }

  .confirm-actions button {
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-primary);
    background: transparent;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .confirm-actions button:hover {
    background: var(--ui-surface-hover);
  }

  .confirm-actions button.danger {
    color: var(--text-on-danger);
    background: var(--accent-danger);
    border-color: var(--accent-danger);
  }

  .md-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
  }

  .md-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 8px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.08s ease, border-color 0.08s ease;
  }

  .md-row:hover {
    background: var(--ui-surface-hover);
  }

  .md-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .md-kind {
    margin-left: 6px;
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 400;
    color: var(--text-secondary);
    border: 1px solid var(--ui-border);
    border-radius: 999px;
  }

  .md-path {
    font-size: 11px;
    color: var(--text-tertiary);
    font-family: ui-monospace, monospace;
  }
</style>
