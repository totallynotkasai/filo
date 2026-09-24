<script lang="ts">
  /**
   * PropertiesPopup — type-detected key/value editor for a tile's metadata.
   *
   * For text tiles: backed by the file's YAML frontmatter (the canonical source
   * for tile metadata). Reads via `vault:read-file-text`, writes back via
   * `vault:write-file-text`, debounced 300ms while typing.
   *
   * For non-text tiles: backed by the tile's in-board `metadata` object.
   * Mutations go through `boardStore.updateTile`.
   */
  import { onMount, onDestroy, getContext } from 'svelte';
  import type { Tile, TextTile } from '../../schema/index';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
  import { documentStore } from '../../stores/document.svelte';
  import { resolveTextTileVaultPath } from '../../lib/boards/textTilePath';
  import {
    markHydrated,
    isHydrated,
    readMarkdownForHydrate,
    scheduleMarkdownWrite as gatewayScheduleMarkdownWrite,
    flushMarkdownWrite,
    cancelMarkdownWrite,
    type WriteArgs,
  } from '../../lib/vault/markdownFileWriter';
  import {
    markPropertiesPopupDirty,
    clearPropertiesPopupDirty,
  } from '../../lib/vault/propertiesPopupTracker';
  import { reportError } from '../../lib/utils/errorBus';
  import { type PropType, detectType, valueForRow } from '../../lib/utils/propertyRowTypes';
  import { diffToFrontmatterDelta } from '../../lib/vault/frontmatterDelta';
  import { IpcEnvelopeError } from '@shared/ipcEnvelope';
  import { createId } from '../../lib/utils/ids';
  import { historyStore } from '../../stores/history.svelte';
  import {
    UpdatePropertiesCommand,
    type PropertiesSnapshot,
  } from '../../commands/index';

  const DEFAULT_STATUSES: readonly string[] = ['todo', 'in-progress', 'done'];

  interface PropertyRow {
    /** Stable per-row identity used for transient UI state. Not persisted. */
    rid: string;
    key: string;
    type: PropType;
    value: unknown;
  }

  let {
    tile,
    onClose,
  }: {
    tile: Tile;
    onClose: () => void;
  } = $props();

  let rows = $state<PropertyRow[]>([]);
  let initialised = $state(false);
  // Same role as TextTile.backingFileMissing — set on ENOENT so subsequent
  // debounced writes don't re-create a file the user just deleted on disk.
  let backingFileMissing = false;

  // Snapshot the canonical "before" state at popup mount so
  // popup-close can dispatch a single UpdatePropertiesCommand spanning every
  // edit made during this session. Per-keystroke commands would blow through
  // MAX_HISTORY for a normal edit; "I opened properties, I undo to close it"
  // matches the user's mental model. JSON round-trip detaches the snapshot
  // from the live $state Proxy / disk cache so later mutations don't leak in.
  let beforeSnapshot: PropertiesSnapshot | null = null;

  /** Per-row search text for the tag chip-picker. Keyed by row.rid, not persisted. */
  let tagSearchTexts = $state<Record<string, string>>({});

  /** Per-row flag forcing the status row into custom-text-input mode. Keyed by row.rid. */
  let statusCustomMode = $state<Record<string, boolean>>({});

  function rowsFromObject(obj: Record<string, unknown>): PropertyRow[] {
    return Object.entries(obj).map(([key, value]) => {
      const type = detectType(key, value);
      return { rid: createId(8), key, type, value: valueForRow(value, type) };
    });
  }

  function rowsToObject(input: PropertyRow[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of input) {
      const trimmedKey = row.key.trim();
      if (!trimmedKey) continue;
      out[trimmedKey] = row.value;
    }
    return out;
  }

  // The tile's note path (its `filePath`), or null for a non-text tile.
  function vaultRelativePath(t: Tile): string | null {
    return resolveTextTileVaultPath(t);
  }

  function loadFromBacking(): void {
    if (tile.type === 'text') {
      const docId = (tile as TextTile).contentId;
      const relPath = vaultRelativePath(tile);
      // Source order:
      //   1. documentStore live cache — set by whichever writer last touched
      //      the file (TextTile / DocumentEditor / TaskListBoard).
      //   2. vaultIndexStore — the disk-canonical snapshot from the watcher.
      //   3. Empty — a note that isn't on disk (yet).
      // The popup is then the canonical authority during its open session;
      // its writes overwrite the cache, so the user's view is always what
      // gets persisted.
      let fm: Record<string, unknown> | undefined;
      if (docId) fm = documentStore.getFrontmatter(docId);
      if (!fm && relPath) {
        const indexed = vaultIndexStore.getMetadata(relPath)?.frontmatter;
        if (indexed) {
          fm = indexed;
          if (docId) documentStore.setFrontmatter(docId, indexed);
        }
      }
      rows = rowsFromObject(fm ?? {});
      if (relPath) {
        beforeSnapshot = {
          kind: 'frontmatter',
          relPath,
          docId: docId ?? null,
          fm: JSON.parse(JSON.stringify(fm ?? {})) as Record<string, unknown>,
        };
      }
    } else {
      const meta = ((tile as Tile & { metadata?: Record<string, unknown> }).metadata) ?? {};
      rows = rowsFromObject(meta);
      beforeSnapshot = {
        kind: 'metadata',
        tileId: tile.id,
        metadata: JSON.parse(JSON.stringify(meta)) as Record<string, unknown>,
      };
    }
    initialised = true;
  }

  /**
   * Builds the gateway WriteArgs from the popup's current rows. Returns
   * null for non-text tiles (those persist via `boardStore.updateTile`
   * directly in `scheduleWrite`) or when the file isn't ready yet.
   */
  function buildFrontmatterWriteArgs(): WriteArgs | null {
    if (tile.type !== 'text' || backingFileMissing) return null;
    const vaultRoot = vaultStore.path;
    const relPath = vaultRelativePath(tile);
    if (!vaultRoot || !relPath) return null;
    const docId = (tile as TextTile).contentId;
    const obj = rowsToObject(rows);
    // The popup is canonical during edit: overwrite the live cache so the
    // next TextTile / DocumentEditor write assembles the file with the
    // user's chosen properties rather than reverting to its own snapshot.
    if (docId) documentStore.setFrontmatter(docId, obj);
    // Body source: prefer the live in-memory body (an open TextTile or
    // DocumentEditor keeps it current with un-debounced keystrokes), and
    // fall back to the watcher-canonical disk content. Without this, a
    // popup write while the user is typing would emit a stale body and
    // truncate the last few keystrokes.
    const docState = docId ? documentStore.getDocument(docId) : null;
    const body = docState?.body ?? vaultIndexStore.getMetadata(relPath)?.content ?? '';
    // Hydration is seeded by the disk read fired from onMount, which records
    // the correct hadBom in `fileState` AND seeds the drift baseline (the
    // index's body-only content is already BOM-stripped, so it can't be
    // sniffed). If onMount's read failed (ENOENT / race), fall back to a
    // no-BOM hydrate so the write below ENOENT-fails with the surfaced toast.
    if (!isHydrated(relPath)) markHydrated(relPath, false);
    // The popup edits in whole-object terms, so the write SOURCE is the delta of everything that
    // changed since the popup opened (`beforeSnapshot.fm` → current rows). A key
    // the popup never touched — including one an external editor added to disk
    // since the popup opened, which is in NEITHER snapshot — is absent from the
    // delta, so the gateway sources it from fresh disk and never reverts it.
    // `frontmatter: obj` stays as the fallback the gateway ignores while a
    // delta is present.
    const openFm =
      beforeSnapshot?.kind === 'frontmatter' ? beforeSnapshot.fm : {};
    const delta = diffToFrontmatterDelta(openFm, obj);
    return {
      vaultRoot,
      relPath,
      frontmatter: obj,
      body,
      callerId: flusherId,
      docId: docId ?? null,
      frontmatterDelta: delta,
      // Fire-time body-source decision (`body` above prefers
      // the live `docState?.body`); the gateway must not re-derive it from
      // the mutable documentStore at write time.
      bodyIsLive: docState != null,
    };
  }

  function scheduleWrite(): void {
    if (tile.type !== 'text') {
      // Non-text tiles persist their metadata directly into board JSON via
      // boardStore.updateTile — no gateway involvement. The in-memory
      // mutation is debounced at the boardCache layer via its dirty flag.
      const obj = rowsToObject(rows);
      boardStore.updateTile(tile.id, { metadata: obj } as Partial<Tile>);
      return;
    }
    const args = buildFrontmatterWriteArgs();
    if (!args) return;
    // Flag the popup as dirty against the backing path so
    // a concurrent external frontmatter edit gets routed to a Reload/Keep-
    // local prompt instead of silently clobbering these pending rows.
    // Cleared in flushPendingWrite's success branch + onDestroy.
    if (flusherId && args.relPath) {
      markPropertiesPopupDirty(flusherId, args.relPath);
    }
    gatewayScheduleMarkdownWrite(args);
  }

  function flushIfPending(): void {
    if (!flusherId) return;
    if (tile.type !== 'text') return;
    void flushPendingWrite();
  }

  async function flushPendingWrite(): Promise<void> {
    if (!flusherId) return;
    // `flushMarkdownWrite` never rejects (failures resolve as `{ ok: false }`),
    // so branch on the result: clearing the dirty flag on a FAILED flush would
    // drop the popup-dirty conflict routing for rows that never landed.
    const result = await flushMarkdownWrite(flusherId);
    if (result.ok) {
      // Write landed; the popup's tracked rows match disk
      // now. Clear the dirty bit so the classifier stops routing future
      // external frontmatter edits to the popup-dirty prompt path.
      clearPropertiesPopupDirty(flusherId);
      return;
    }
    const err = result.error;
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      const relPath = vaultRelativePath(tile);
      backingFileMissing = true;
      // Backing file is gone — there is no path left to be dirty against.
      clearPropertiesPopupDirty(flusherId);
      reportError(
        'PropertiesPopup',
        null,
        `"${relPath ?? 'File'}" no longer exists on disk. Further property changes won't be saved until the file is restored.`,
      );
      return;
    }
    // Don't clear on other failures — the next flush attempt (close, Ctrl+S)
    // should still see the rows as dirty so the user's choice is honoured.
    // No reportError: trackComponentWrite already surfaced the failure
    // through the save-error pipeline; a second toast would double-report.
  }

  function addProperty(): void {
    rows = [...rows, { rid: createId(8), key: '', type: 'text', value: '' }];
  }

  function removeProperty(index: number): void {
    const rid = rows[index]?.rid;
    rows = rows.filter((_, i) => i !== index);
    if (rid) {
      delete tagSearchTexts[rid];
      delete statusCustomMode[rid];
    }
    scheduleWrite();
  }

  function updateRow(index: number, patch: Partial<PropertyRow>): void {
    rows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    scheduleWrite();
  }

  function changeType(index: number, nextType: PropType): void {
    const row = rows[index];
    if (!row) return;
    if (row.type === 'status' && nextType !== 'status') {
      delete statusCustomMode[row.rid];
    }
    if (row.type === 'tag' && nextType !== 'tag') {
      delete tagSearchTexts[row.rid];
    }
    updateRow(index, { type: nextType, value: valueForRow(row.value, nextType) });
  }

  function listToText(value: unknown): string {
    return Array.isArray(value) ? value.join(', ') : '';
  }

  function textToList(text: string): string[] {
    return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }

  /**
   * A compact, read-only preview for a `raw` row: a structured
   * value (nested object/array, or an array with non-string items) the typed
   * editors can't represent without loss. JSON is unambiguous; the value itself
   * is preserved verbatim by `valueForRow('raw')`, so this is display-only.
   */
  function rawPreview(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function getTagArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((v) => String(v)) : [];
  }

  function addTagToRow(index: number, tag: string): void {
    const trimmed = tag.trim().replace(/^#+/, '');
    if (!trimmed) return;
    const current = getTagArray(rows[index]?.value);
    if (current.includes(trimmed)) return;
    updateRow(index, { value: [...current, trimmed] });
  }

  function removeTagFromRow(index: number, tag: string): void {
    const current = getTagArray(rows[index]?.value);
    updateRow(index, { value: current.filter((t) => t !== tag) });
  }

  function commitTagInput(index: number): void {
    const row = rows[index];
    if (!row) return;
    const text = (tagSearchTexts[row.rid] ?? '').trim();
    if (!text) return;
    addTagToRow(index, text);
    tagSearchTexts[row.rid] = '';
  }

  function tagSuggestions(currentValue: unknown, search: string): string[] {
    const selected = new Set(getTagArray(currentValue));
    const all = vaultIndexStore.allTags();
    const needle = search.trim().replace(/^#+/, '').toLowerCase();
    const out: string[] = [];
    for (const [name] of all) {
      if (selected.has(name)) continue;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      out.push(name);
      if (out.length >= 8) break;
    }
    return out;
  }

  function tagSearchExactMatchExists(currentValue: unknown, search: string): boolean {
    const text = search.trim().replace(/^#+/, '');
    if (!text) return true;
    const selected = new Set(getTagArray(currentValue));
    if (selected.has(text)) return true;
    for (const [name] of vaultIndexStore.allTags()) {
      if (name === text) return true;
    }
    return false;
  }

  function isStatusCustom(row: PropertyRow): boolean {
    if (statusCustomMode[row.rid]) return true;
    const v = typeof row.value === 'string' ? row.value : '';
    return v.length > 0 && !DEFAULT_STATUSES.includes(v);
  }

  function pickStatus(index: number, value: string): void {
    const row = rows[index];
    if (!row) return;
    if (value === '__custom__') {
      statusCustomMode[row.rid] = true;
      updateRow(index, { value: '' });
      return;
    }
    statusCustomMode[row.rid] = false;
    updateRow(index, { value });
  }

  function revertStatusToList(index: number): void {
    const row = rows[index];
    if (!row) return;
    statusCustomMode[row.rid] = false;
    updateRow(index, { value: 'todo' });
  }

  let flusherId = '';
  // Capture the originating board at popup MOUNT, from the PANE-SCOPED
  // `scope.board` (the `boardStore` alias above), not the global facade at
  // destroy time. The deferred UpdatePropertiesCommand is built during
  // onDestroy; resolving the globally-active board then would push the edit
  // onto the wrong pane's undo stack if the user clicked another pane first.
  let mountBoardId = '';

  onMount(() => {
    flusherId = `properties-popup:${tile.id}:${createId(6)}`;
    mountBoardId = boardStore.current?.id ?? '';
    loadFromBacking();
    // Async disk-read hydrate so the popup's first write
    // assembles against the correct BOM byte AND a drift baseline seeded
    // from the same read. Skip when a sibling editor already hydrated
    // the file (its fileState entry is correct) or when there is no
    // backing file (non-text tile / unresolved relPath). The promise is
    // fire-and-forget — a failed read leaves `fileState` empty, and
    // `buildFrontmatterWriteArgs` falls back to `markHydrated(false)`
    // so the first write surfaces the ENOENT through the gateway's
    // error path instead of crashing.
    if (tile.type === 'text') {
      const vaultRoot = vaultStore.path;
      const relPath = vaultRelativePath(tile);
      if (vaultRoot && relPath && !isHydrated(relPath)) {
        void readMarkdownForHydrate(vaultRoot, relPath).catch(() => {
          // Read failed (ENOENT, EACCES, …). buildFrontmatterWriteArgs's
          // `if (!isHydrated) markHydrated(false)` fallback handles the
          // write path; nothing to do here.
        });
      }
    }
  });

  onDestroy(() => {
    // Drain any pending debounced write before the popup unmounts. The
    // gateway's flush awaits the in-flight write; the local fire-and-forget
    // wrapper matches the popup's previous "drain on close" semantics
    // (history entry is pushed after).
    flushIfPending();
    pushHistoryEntry();
    // Best-effort: cancel the gateway TIMER for this flusherId so a late
    // schedule armed in the same tick as onDestroy doesn't fire against a
    // popup that's already torn down. `pendingOnly: true` cancels ONLY an armed
    // timer, never a PARKED fire: `flushIfPending()` above already owns the
    // parked/in-flight write, so the plain cancel (which marks a parked fire
    // cancelled) would silently drop the freshest edits.
    if (flusherId) {
      cancelMarkdownWrite(flusherId, true);
      // Defence in depth: ensure the popup's tracker entry
      // is gone even if flushPendingWrite never resolved (sync teardown
      // before the promise settled). A stale entry would block the
      // sync-frontmatter short-circuit on this path indefinitely.
      clearPropertiesPopupDirty(flusherId);
    }
  });

  /**
   * Push a single UpdatePropertiesCommand for the whole popup session if
   * the user actually changed something. The disk write has already
   * happened (live preview via `scheduleWrite`); `pushWithoutExecute`
   * records the diff so Ctrl+Z restores both the cache + the on-disk YAML.
   */
  function pushHistoryEntry(): void {
    if (!beforeSnapshot) return;
    const afterSnapshot = buildAfterSnapshot();
    if (!afterSnapshot) return;
    if (snapshotsEqual(beforeSnapshot, afterSnapshot)) return;
    // Pass the mount-time board id so the command targets the
    // pane this popup belongs to, not whichever board is active at close time.
    historyStore.pushWithoutExecute(
      new UpdatePropertiesCommand(beforeSnapshot, afterSnapshot, mountBoardId),
    );
  }

  function buildAfterSnapshot(): PropertiesSnapshot | null {
    if (!beforeSnapshot) return null;
    const obj = rowsToObject(rows);
    if (beforeSnapshot.kind === 'frontmatter') {
      return {
        kind: 'frontmatter',
        relPath: beforeSnapshot.relPath,
        docId: beforeSnapshot.docId,
        fm: obj,
      };
    }
    return { kind: 'metadata', tileId: beforeSnapshot.tileId, metadata: obj };
  }

  function snapshotsEqual(a: PropertiesSnapshot, b: PropertiesSnapshot): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'frontmatter' && b.kind === 'frontmatter') {
      return JSON.stringify(a.fm) === JSON.stringify(b.fm);
    }
    if (a.kind === 'metadata' && b.kind === 'metadata') {
      return JSON.stringify(a.metadata) === JSON.stringify(b.metadata);
    }
    return false;
  }

  // Focus restoration: capture the element that opened the popup so keyboard
  // users return to it on close.
  $effect(() => {
    const triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (triggerEl && triggerEl.isConnected) {
        try { triggerEl.focus(); } catch { /* no longer focusable */ }
      }
    };
  });
</script>

<div class="properties-popup" role="dialog" aria-labelledby="properties-popup-title">
  <div class="header">
    <h3 id="properties-popup-title">Properties</h3>
    <button class="close-btn" onclick={onClose} aria-label="Close properties">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  {#if !initialised}
    <div class="empty">Loading…</div>
  {:else if rows.length === 0}
    <div class="empty">No properties yet</div>
  {:else}
    <div class="rows">
      {#each rows as row, index (row.rid)}
        {@const propLabel = row.key.trim() || `row ${index + 1}`}
        <div class="row">
          <input
            class="key-input"
            type="text"
            placeholder="key"
            value={row.key}
            oninput={(e) => updateRow(index, { key: (e.target as HTMLInputElement).value })}
            aria-label="Property name: {propLabel}"
          />

          <select
            class="type-select"
            value={row.type}
            onchange={(e) => changeType(index, (e.target as HTMLSelectElement).value as PropType)}
            disabled={row.type === 'raw'}
            aria-label="Property type for {propLabel}"
          >
            {#if row.type === 'raw'}
              <!-- A structured value can't be re-typed without
                   loss, so the select is disabled; this option just labels it. -->
              <option value="raw">Raw</option>
            {/if}
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option value="date">Date</option>
            <option value="list">List</option>
            <option value="tag">Tag</option>
            <option value="status">Status</option>
          </select>

          <div class="value-cell" class:value-cell-stack={row.type === 'tag'}>
            {#if row.type === 'raw'}
              <!-- Read-only verbatim preview. A nested object /
                   numeric array round-trips untouched; editing it here would
                   coerce it lossily, so it's display-only with a hint. -->
              <code
                class="raw-value"
                title="Structured value — edit in your text editor to preserve it"
              >{rawPreview(row.value)}</code>
            {:else if row.type === 'boolean'}
              <input
                type="checkbox"
                checked={Boolean(row.value)}
                onchange={(e) => updateRow(index, { value: (e.target as HTMLInputElement).checked })}
                aria-label="Boolean value for {propLabel}"
              />
            {:else if row.type === 'number'}
              <input
                type="number"
                class="value-input"
                value={typeof row.value === 'number' ? row.value : 0}
                oninput={(e) => updateRow(index, { value: Number((e.target as HTMLInputElement).value) || 0 })}
                aria-label="Number value for {propLabel}"
              />
            {:else if row.type === 'date'}
              <input
                type="date"
                class="value-input"
                value={typeof row.value === 'string' ? row.value : ''}
                oninput={(e) => updateRow(index, { value: (e.target as HTMLInputElement).value })}
                aria-label="Date value for {propLabel}"
              />
            {:else if row.type === 'list'}
              <input
                type="text"
                class="value-input"
                placeholder="comma, separated, items"
                value={listToText(row.value)}
                oninput={(e) => updateRow(index, { value: textToList((e.target as HTMLInputElement).value) })}
                aria-label="List value for {propLabel}"
              />
            {:else if row.type === 'tag'}
              {@const selectedTags = getTagArray(row.value)}
              {@const search = tagSearchTexts[row.rid] ?? ''}
              {@const suggestions = tagSuggestions(row.value, search)}
              {@const exactExists = tagSearchExactMatchExists(row.value, search)}
              <div class="tag-chips" role="list" aria-label="Selected tags for {propLabel}">
                {#each selectedTags as tag (tag)}
                  <span class="tag-chip" role="listitem">
                    <span class="tag-chip-text">#{tag}</span>
                    <button
                      class="tag-chip-remove"
                      onclick={() => removeTagFromRow(index, tag)}
                      aria-label="Remove tag {tag}"
                      title="Remove tag"
                    ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                  </span>
                {/each}
              </div>
              <input
                type="text"
                class="value-input tag-search-input"
                placeholder="Add tag…"
                value={search}
                oninput={(e) => (tagSearchTexts[row.rid] = (e.target as HTMLInputElement).value)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTagInput(index);
                  } else if (e.key === 'Backspace' && !search && selectedTags.length > 0) {
                    e.preventDefault();
                    const lastTag = selectedTags[selectedTags.length - 1];
                    if (lastTag) removeTagFromRow(index, lastTag);
                  }
                }}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={!!search.trim()}
                aria-controls={`tag-suggestions-${row.rid}`}
                aria-label="Tag search for {propLabel}"
              />
              {#if search.trim()}
                <div class="tag-suggestions" role="listbox" id={`tag-suggestions-${row.rid}`}>
                  {#each suggestions as name (name)}
                    <button
                      class="tag-suggestion"
                      onclick={() => { addTagToRow(index, name); tagSearchTexts[row.rid] = ''; }}
                      role="option"
                      aria-selected="false"
                    >#{name}</button>
                  {/each}
                  {#if !exactExists}
                    <button
                      class="tag-suggestion tag-suggestion-new"
                      onclick={() => commitTagInput(index)}
                    >+ Add new tag “{search.trim().replace(/^#+/, '')}”</button>
                  {/if}
                  {#if suggestions.length === 0 && exactExists}
                    <div class="tag-suggestion-empty">Already added</div>
                  {/if}
                </div>
              {/if}
            {:else if row.type === 'status'}
              {#if isStatusCustom(row)}
                <input
                  type="text"
                  class="value-input"
                  placeholder="Custom status"
                  value={typeof row.value === 'string' ? row.value : ''}
                  oninput={(e) => updateRow(index, { value: (e.target as HTMLInputElement).value })}
                  aria-label="Custom status value for {propLabel}"
                  title="Custom statuses are written to the file's frontmatter and persist between sessions. Click the chevron to switch back to the default list."
                />
                <button
                  class="status-revert-btn"
                  onclick={() => revertStatusToList(index)}
                  title="Pick from defaults"
                  aria-label="Pick from default statuses"
                ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              {:else}
                <select
                  class="value-input status-select"
                  value={typeof row.value === 'string' ? row.value : 'todo'}
                  onchange={(e) => pickStatus(index, (e.target as HTMLSelectElement).value)}
                  aria-label="Status value for {propLabel}"
                >
                  {#each DEFAULT_STATUSES as opt (opt)}
                    <option value={opt}>{opt}</option>
                  {/each}
                  <option value="__custom__">+ Add custom…</option>
                </select>
              {/if}
            {:else}
              <input
                type="text"
                class="value-input"
                value={typeof row.value === 'string' ? row.value : ''}
                oninput={(e) => updateRow(index, { value: (e.target as HTMLInputElement).value })}
                aria-label="Text value for {propLabel}"
              />
            {/if}
          </div>

          <button
            class="remove-btn"
            onclick={() => removeProperty(index)}
            title="Remove property"
            aria-label="Remove property"
          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      {/each}
    </div>
  {/if}

  <button class="add-btn" onclick={addProperty}>
    + Add property
  </button>
</div>

<style>
  .properties-popup {
    width: 360px;
    max-height: 70vh;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-elevated);
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 10px;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
  }

  .close-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .empty {
    font-size: 12px;
    color: var(--text-tertiary);
    padding: 8px 4px;
    text-align: center;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    max-height: 50vh;
    padding-right: 2px;
  }

  .row {
    display: grid;
    grid-template-columns: 110px 80px 1fr 22px;
    align-items: center;
    gap: 6px;
  }

  .key-input,
  .type-select,
  .value-input {
    height: 26px;
    padding: 2px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-system);
    box-sizing: border-box;
    min-width: 0;
  }

  .value-cell {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 4px;
    position: relative;
  }

  .value-cell-stack {
    flex-direction: column;
    align-items: stretch;
  }

  .value-input {
    width: 100%;
  }

  /* Read-only structured-value preview. */
  .raw-value {
    display: block;
    width: 100%;
    height: 26px;
    line-height: 22px;
    padding: 2px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    box-sizing: border-box;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: default;
  }

  .tag-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .tag-chips:empty {
    display: none;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 20px;
    padding: 0 4px 0 6px;
    border-radius: 10px;
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    font-size: 11px;
    line-height: 1;
  }

  .tag-chip-text {
    white-space: nowrap;
  }

  .tag-chip-remove {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0;
  }

  .tag-chip-remove:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .tag-search-input {
    width: 100%;
  }

  .tag-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    margin-top: 2px;
    max-height: 180px;
    overflow-y: auto;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    box-shadow: var(--ui-shadow-elevated);
    display: flex;
    flex-direction: column;
    padding: 2px;
  }

  .tag-suggestion {
    text-align: left;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }

  .tag-suggestion:hover {
    background: var(--ui-surface-hover);
  }

  .tag-suggestion-new {
    color: var(--text-secondary);
    font-style: italic;
    border-top: 1px solid var(--ui-border);
    margin-top: 2px;
    padding-top: 6px;
  }

  .tag-suggestion-empty {
    font-size: 11px;
    color: var(--text-tertiary);
    padding: 4px 8px;
  }

  .status-select {
    flex: 1;
  }

  .status-revert-btn {
    width: 22px;
    height: 26px;
    flex: 0 0 auto;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
  }

  .status-revert-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .remove-btn {
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .remove-btn:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .add-btn {
    align-self: flex-start;
    padding: 4px 10px;
    border: 1px dashed var(--ui-border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .add-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    border-color: var(--ui-border-focus);
  }
</style>
