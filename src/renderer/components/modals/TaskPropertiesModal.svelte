<script lang="ts">
  /**
   * TaskPropertiesModal — read-only inspector for a task row.
   *
   * Shows the canonical identifiers and metadata a power user needs when
   * triaging a task that doesn't display "right" — tile id, vault-relative
   * file path, created/modified timestamps, full frontmatter, and the
   * placement JSON on the current board. v1 is read-only: edits still flow
   * through the row controls and the source .md file.
   */
  import type { Tile, TaskPlacement } from '../../schema/index';

  let {
    tile,
    placement,
    filePath,
    frontmatter,
  }: {
    tile: Tile;
    placement: TaskPlacement;
    filePath: string;
    frontmatter: Record<string, unknown>;
  } = $props();

  function formatTimestamp(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '—';
    }
  }

  function prettyJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '/* unserialisable */';
    }
  }

  let frontmatterText = $derived(prettyJson(frontmatter ?? {}));
  let placementText = $derived(prettyJson(placement));
</script>

<div class="properties-body">
  <section class="properties-section">
    <h3 class="properties-section-title">Identity</h3>
    <dl class="properties-list">
      <dt>Tile ID</dt>
      <dd><code class="properties-mono">{tile.id}</code></dd>
      <dt>Title</dt>
      <dd>{tile.title || '—'}</dd>
      <dt>Type</dt>
      <dd><code class="properties-mono">{tile.type}</code></dd>
      <dt>File path</dt>
      <dd><code class="properties-mono" title={filePath}>{filePath || '—'}</code></dd>
    </dl>
  </section>

  <section class="properties-section">
    <h3 class="properties-section-title">Timestamps</h3>
    <dl class="properties-list">
      <dt>Created</dt>
      <dd>{formatTimestamp(tile.createdAt)}</dd>
      <dt>Modified</dt>
      <dd>{formatTimestamp(tile.updatedAt)}</dd>
    </dl>
  </section>

  <section class="properties-section">
    <h3 class="properties-section-title">Frontmatter</h3>
    <pre class="properties-json"><code>{frontmatterText}</code></pre>
  </section>

  <section class="properties-section">
    <h3 class="properties-section-title">Placement</h3>
    <pre class="properties-json"><code>{placementText}</code></pre>
  </section>
</div>

<style>
  .properties-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .properties-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .properties-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-tertiary);
    margin: 0;
  }

  .properties-list {
    display: grid;
    grid-template-columns: 110px 1fr;
    column-gap: 12px;
    row-gap: 4px;
    margin: 0;
    font-size: 12px;
  }

  .properties-list dt {
    color: var(--text-secondary);
  }

  .properties-list dd {
    margin: 0;
    color: var(--text-primary);
    word-break: break-all;
  }

  .properties-mono {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-primary);
    background: var(--ui-surface-sunken, var(--ui-surface));
    padding: 1px 4px;
    border-radius: 3px;
  }

  .properties-json {
    margin: 0;
    padding: 8px 10px;
    background: var(--ui-surface-sunken, var(--ui-surface));
    border: 1px solid var(--ui-border-light);
    border-radius: 6px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-primary);
    line-height: 1.5;
    overflow: auto;
    max-height: 220px;
    white-space: pre;
  }
</style>
