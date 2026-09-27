<script lang="ts">
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import BackgroundImagePicker from '../shared/BackgroundImagePicker.svelte';
  import type { BoardType } from '../../../shared/types';
  import { ProjectSettingsSchema } from '../../schema/index';
  import { readPath } from '../../lib/settings/currentBoardHelpers';
  import { numberBoundsAt, readNumberField } from '../../lib/settings/numberInput';
  import {
    SHAPE_OPTIONS,
    BORDER_STYLE_OPTIONS,
    BACKGROUND_PATTERN_OPTIONS,
    PATH_TYPE_OPTIONS,
    ARROW_TYPE_OPTIONS,
  } from '../../constants/styleOptions';

  let selectedBoard = $state<BoardType>('mindmap');

  const boardOptions: { value: BoardType; label: string }[] = [
    { value: 'mindmap', label: 'Mind Map' },
    { value: 'kanban', label: 'Kanban Board' },
    { value: 'tasklist', label: 'Task List' },
    { value: 'document', label: 'Document' },
  ];

  // Reads route through `pendingSettingsStore.effective`, which returns
  // the editable copy during an Apply / Revert session and otherwise the
  // live project settings.
  let settings = $derived(pendingSettingsStore.effective);
  let mindmapDefaults = $derived(settings?.mindmap);
  let kanbanDefaults = $derived(settings?.kanban);
  let tasklistDefaults = $derived(settings?.tasklist);
  let documentDefaults = $derived(settings?.document);

  /**
   * Writes a settings field into the pending copy. The pending session
   * is started by `ProjectSettings.svelte` on modal mount, so this
   * always has somewhere to write. The Apply / Revert bar is the
   * dialog's (see `ProjectSettings.svelte`).
   */
  function update(path: string, value: unknown) {
    pendingSettingsStore.update(path, value);
  }

  /**
   * Commits a number field, clamped to the settings schema's range for it.
   * A non-number puts the field back to its last value; blank clears an
   * `optional` field. An unchecked NaN would save as `null` and reset the
   * whole board type's defaults on the next load.
   */
  function setNumber(input: HTMLInputElement, path: string, optional = false) {
    const last = readPath(settings, path);
    const value = readNumberField(
      input,
      numberBoundsAt(ProjectSettingsSchema, path),
      typeof last === 'number' ? last : undefined,
      optional,
    );
    if (value === undefined && !optional) return;
    update(path, value);
  }

</script>

<div class="board-defaults">
  <h3 class="section-title">Board Defaults</h3>
  <p class="rule-hint">
    Every board follows these, for each field it leaves blank in its Current Board tab, including
    boards you already have. A blank colour here uses the theme's colour.
  </p>

  <div class="setting-row">
    <label class="setting-label" for="board-type-select">Board Type</label>
    <select
      id="board-type-select"
      class="setting-select"
      bind:value={selectedBoard}
    >
      {#each boardOptions as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>

  <div class="setting-divider"></div>

  <!-- ── Mind Map Defaults ── -->
  {#if selectedBoard === 'mindmap' && mindmapDefaults}
    <div class="defaults-section">
      <h4 class="subsection-title">Board</h4>
      <div class="setting-row">
        <span class="setting-label">Background Color</span>
        <ColorPicker value={mindmapDefaults.backgroundColor} onchange={(c) => update('mindmap.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-pattern">Background Pattern</label>
        <select id="mm-pattern" class="setting-select" value={mindmapDefaults.backgroundPattern} onchange={(e) => update('mindmap.backgroundPattern', (e.target as HTMLSelectElement).value)}>
          {#each BACKGROUND_PATTERN_OPTIONS as p (p)}<option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>{/each}
        </select>
      </div>

      <h4 class="subsection-title">Tile Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Header Color</span>
        <ColorPicker value={mindmapDefaults.tile.headerColor} onchange={(c) => update('mindmap.tile.headerColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={mindmapDefaults.tile.bodyColor} onchange={(c) => update('mindmap.tile.bodyColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={mindmapDefaults.tile.borderColor} onchange={(c) => update('mindmap.tile.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-shape">Shape</label>
        <select id="mm-shape" class="setting-select" value={mindmapDefaults.tile.shape} onchange={(e) => update('mindmap.tile.shape', (e.target as HTMLSelectElement).value)}>
          {#each SHAPE_OPTIONS as s (s)}<option value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-border-style">Border Style</label>
        <select id="mm-border-style" class="setting-select" value={mindmapDefaults.tile.borderStyle} onchange={(e) => update('mindmap.tile.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-border-width">Border Width</label>
        <input id="mm-border-width" class="setting-input number-input" type="number" min="0" max="10" value={mindmapDefaults.tile.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'mindmap.tile.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-shadow">Shadow Intensity</label>
        <input id="mm-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={mindmapDefaults.tile.shadowIntensity} oninput={(e) => update('mindmap.tile.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-tile-dct">Dynamic Contrast Text</label>
        <select id="mm-tile-dct" class="setting-select" value={mindmapDefaults.tile.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('mindmap.tile.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-tile-fs-title">Title Font Size</label>
        <input
          id="mm-tile-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={mindmapDefaults.tile.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'mindmap.tile.fontSizeTitle', true)}
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-tile-fs-body">Body Font Size</label>
        <input
          id="mm-tile-fs-body"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={mindmapDefaults.tile.fontSizeBody ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'mindmap.tile.fontSizeBody', true)}
        />
      </div>

      <h4 class="subsection-title">Connection Path Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Path Color</span>
        <ColorPicker value={mindmapDefaults.connectionPath.pathColor} onchange={(c) => update('mindmap.connectionPath.pathColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-path-size">Path Size</label>
        <input id="mm-path-size" class="setting-input number-input" type="number" min="1" max="10" value={mindmapDefaults.connectionPath.pathSize} onchange={(e) => setNumber(e.currentTarget, 'mindmap.connectionPath.pathSize')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-path-type">Path Type</label>
        <select id="mm-path-type" class="setting-select" value={mindmapDefaults.connectionPath.pathType} onchange={(e) => update('mindmap.connectionPath.pathType', (e.target as HTMLSelectElement).value)}>
          {#each PATH_TYPE_OPTIONS as p (p)}<option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-path-style">Path Style</label>
        <select id="mm-path-style" class="setting-select" value={mindmapDefaults.connectionPath.pathStyle} onchange={(e) => update('mindmap.connectionPath.pathStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-arrow-type">Arrow Type</label>
        <select id="mm-arrow-type" class="setting-select" value={mindmapDefaults.connectionPath.arrowType} onchange={(e) => update('mindmap.connectionPath.arrowType', (e.target as HTMLSelectElement).value)}>
          {#each ARROW_TYPE_OPTIONS as a (a)}<option value={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <span class="setting-label">Arrow Color</span>
        <ColorPicker value={mindmapDefaults.connectionPath.arrowColor} onchange={(c) => update('mindmap.connectionPath.arrowColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-arrow-size">Arrow Size</label>
        <input id="mm-arrow-size" class="setting-input number-input" type="number" min="4" max="24" value={mindmapDefaults.connectionPath.arrowSize} onchange={(e) => setNumber(e.currentTarget, 'mindmap.connectionPath.arrowSize')} />
      </div>

      <h4 class="subsection-title">Connection Label Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Text Color</span>
        <ColorPicker value={mindmapDefaults.connectionLabel.textColor} onchange={(c) => update('mindmap.connectionLabel.textColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Label Background</span>
        <ColorPicker value={mindmapDefaults.connectionLabel.backgroundColor} onchange={(c) => update('mindmap.connectionLabel.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-label-font-size">Font Size</label>
        <input
          id="mm-label-font-size"
          class="setting-input number-input"
          type="number"
          min="8"
          max="32"
          placeholder="—"
          value={mindmapDefaults.connectionLabel.fontSize ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'mindmap.connectionLabel.fontSize', true)}
        />
      </div>

      <h4 class="subsection-title">Creation Defaults</h4>
      <div class="setting-row">
        <label class="setting-label" for="mm-label-text">Default Label Text</label>
        <input id="mm-label-text" class="setting-input" type="text" value={mindmapDefaults.connectionLabel.defaultText} onchange={(e) => update('mindmap.connectionLabel.defaultText', (e.target as HTMLInputElement).value)} placeholder="Leave blank for no default" />
      </div>

      <h4 class="subsection-title">Frame Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Header Color</span>
        <ColorPicker value={mindmapDefaults.frame.headerColor} onchange={(c) => update('mindmap.frame.headerColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={mindmapDefaults.frame.bodyColor} onchange={(c) => update('mindmap.frame.bodyColor', c)} />
      </div>
      <div class="setting-row bg-image-row">
        <span class="setting-label">Background Image</span>
        <BackgroundImagePicker
          value={mindmapDefaults.frame.backgroundImage ?? ''}
          onChange={(v) => update('mindmap.frame.backgroundImage', v)}
          title="Choose Default Frame Background Image"
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-opacity">Opacity</label>
        <input id="mm-frame-opacity" class="setting-range" type="range" min="0" max="1" step="0.05" value={mindmapDefaults.frame.backgroundOpacity} oninput={(e) => update('mindmap.frame.backgroundOpacity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={mindmapDefaults.frame.borderColor} onchange={(c) => update('mindmap.frame.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-border-style">Border Style</label>
        <select id="mm-frame-border-style" class="setting-select" value={mindmapDefaults.frame.borderStyle} onchange={(e) => update('mindmap.frame.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-border-width">Border Width</label>
        <input id="mm-frame-border-width" class="setting-input number-input" type="number" min="0" max="10" value={mindmapDefaults.frame.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'mindmap.frame.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-shadow">Shadow Intensity</label>
        <input id="mm-frame-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={mindmapDefaults.frame.shadowIntensity} oninput={(e) => update('mindmap.frame.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-dct">Dynamic Contrast Text</label>
        <select id="mm-frame-dct" class="setting-select" value={mindmapDefaults.frame.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('mindmap.frame.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="mm-frame-fs-title">Title Font Size</label>
        <input
          id="mm-frame-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={mindmapDefaults.frame.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'mindmap.frame.fontSizeTitle', true)}
        />
      </div>
    </div>
  {/if}

  <!-- ── Kanban Defaults ── -->
  {#if selectedBoard === 'kanban' && kanbanDefaults}
    <div class="defaults-section">
      <h4 class="subsection-title">Board</h4>
      <div class="setting-row">
        <span class="setting-label">Background Color</span>
        <ColorPicker value={kanbanDefaults.backgroundColor} onchange={(c) => update('kanban.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-pattern">Background Pattern</label>
        <select id="kb-pattern" class="setting-select" value={kanbanDefaults.backgroundPattern} onchange={(e) => update('kanban.backgroundPattern', (e.target as HTMLSelectElement).value)}>
          {#each BACKGROUND_PATTERN_OPTIONS as p (p)}<option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <span class="setting-label">Accent Color</span>
        <ColorPicker value={kanbanDefaults.accentColor} onchange={(c) => update('kanban.accentColor', c)} />
      </div>

      <h4 class="subsection-title">Column Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Header Color</span>
        <ColorPicker value={kanbanDefaults.column.headerColor} onchange={(c) => update('kanban.column.headerColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={kanbanDefaults.column.bodyColor} onchange={(c) => update('kanban.column.bodyColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={kanbanDefaults.column.borderColor} onchange={(c) => update('kanban.column.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-border">Border Style</label>
        <select id="kb-col-border" class="setting-select" value={kanbanDefaults.column.borderStyle} onchange={(e) => update('kanban.column.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-bw">Border Width</label>
        <input id="kb-col-bw" class="setting-input number-input" type="number" min="0" max="10" value={kanbanDefaults.column.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'kanban.column.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-shadow">Shadow Intensity</label>
        <input id="kb-col-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={kanbanDefaults.column.shadowIntensity} oninput={(e) => update('kanban.column.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-dct">Dynamic Contrast Text</label>
        <select id="kb-col-dct" class="setting-select" value={kanbanDefaults.column.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('kanban.column.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-width">Column Width (px)</label>
        <input
          id="kb-col-width"
          class="setting-input number-input"
          type="number"
          min="120"
          max="2000"
          step="10"
          value={kanbanDefaults.column.width}
          onchange={(e) => setNumber(e.currentTarget, 'kanban.column.width')}
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-col-fs-title">Title Font Size</label>
        <input
          id="kb-col-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={kanbanDefaults.column.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'kanban.column.fontSizeTitle', true)}
        />
      </div>

      <h4 class="subsection-title">Card Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Background Color</span>
        <ColorPicker value={kanbanDefaults.card.backgroundColor} onchange={(c) => update('kanban.card.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={kanbanDefaults.card.borderColor} onchange={(c) => update('kanban.card.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-border">Border Style</label>
        <select id="kb-card-border" class="setting-select" value={kanbanDefaults.card.borderStyle} onchange={(e) => update('kanban.card.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-bw">Border Width</label>
        <input id="kb-card-bw" class="setting-input number-input" type="number" min="0" max="10" value={kanbanDefaults.card.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'kanban.card.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-shadow">Shadow Intensity</label>
        <input id="kb-card-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={kanbanDefaults.card.shadowIntensity} oninput={(e) => update('kanban.card.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-dct">Dynamic Contrast Text</label>
        <select id="kb-card-dct" class="setting-select" value={kanbanDefaults.card.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('kanban.card.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-fs-title">Title Font Size</label>
        <input
          id="kb-card-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={kanbanDefaults.card.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'kanban.card.fontSizeTitle', true)}
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="kb-card-fs-body">Body Font Size</label>
        <input
          id="kb-card-fs-body"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={kanbanDefaults.card.fontSizeBody ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'kanban.card.fontSizeBody', true)}
        />
      </div>
    </div>
  {/if}

  <!-- ── Task List Defaults ── -->
  {#if selectedBoard === 'tasklist' && tasklistDefaults}
    <div class="defaults-section">
      <h4 class="subsection-title">Board</h4>
      <div class="setting-row">
        <span class="setting-label">Background Color</span>
        <ColorPicker value={tasklistDefaults.backgroundColor} onchange={(c) => update('tasklist.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-pattern">Background Pattern</label>
        <select id="tl-pattern" class="setting-select" value={tasklistDefaults.backgroundPattern} onchange={(e) => update('tasklist.backgroundPattern', (e.target as HTMLSelectElement).value)}>
          {#each BACKGROUND_PATTERN_OPTIONS as p (p)}<option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <span class="setting-label">Accent Color</span>
        <ColorPicker value={tasklistDefaults.accentColor} onchange={(c) => update('tasklist.accentColor', c)} />
      </div>

      <h4 class="subsection-title">Task Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={tasklistDefaults.task.bodyColor} onchange={(c) => update('tasklist.task.bodyColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={tasklistDefaults.task.borderColor} onchange={(c) => update('tasklist.task.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-border">Border Style</label>
        <select id="tl-border" class="setting-select" value={tasklistDefaults.task.borderStyle} onchange={(e) => update('tasklist.task.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-bw">Border Width</label>
        <input id="tl-bw" class="setting-input number-input" type="number" min="0" max="10" value={tasklistDefaults.task.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'tasklist.task.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-shadow">Shadow Intensity</label>
        <input id="tl-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={tasklistDefaults.task.shadowIntensity} oninput={(e) => update('tasklist.task.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-task-dct">Dynamic Contrast Text</label>
        <select id="tl-task-dct" class="setting-select" value={tasklistDefaults.task.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('tasklist.task.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-task-fs-title">Title Font Size</label>
        <input
          id="tl-task-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={tasklistDefaults.task.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'tasklist.task.fontSizeTitle', true)}
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-task-fs-body">Body Font Size</label>
        <input
          id="tl-task-fs-body"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={tasklistDefaults.task.fontSizeBody ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'tasklist.task.fontSizeBody', true)}
        />
      </div>

      <h4 class="subsection-title">Section Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Header Color</span>
        <ColorPicker value={tasklistDefaults.section.headerColor} onchange={(c) => update('tasklist.section.headerColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={tasklistDefaults.section.bodyColor} onchange={(c) => update('tasklist.section.bodyColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={tasklistDefaults.section.borderColor} onchange={(c) => update('tasklist.section.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-section-border">Border Style</label>
        <select id="tl-section-border" class="setting-select" value={tasklistDefaults.section.borderStyle} onchange={(e) => update('tasklist.section.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-section-bw">Border Width</label>
        <input id="tl-section-bw" class="setting-input number-input" type="number" min="0" max="10" value={tasklistDefaults.section.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'tasklist.section.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-section-shadow">Shadow Intensity</label>
        <input id="tl-section-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={tasklistDefaults.section.shadowIntensity} oninput={(e) => update('tasklist.section.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-section-dct">Dynamic Contrast Text</label>
        <select id="tl-section-dct" class="setting-select" value={tasklistDefaults.section.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('tasklist.section.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="tl-section-fs-title">Title Font Size</label>
        <input
          id="tl-section-fs-title"
          class="setting-input number-input"
          type="number"
          min="8"
          max="48"
          placeholder="—"
          value={tasklistDefaults.section.fontSizeTitle ?? ''}
          onchange={(e) => setNumber(e.currentTarget, 'tasklist.section.fontSizeTitle', true)}
        />
      </div>
    </div>
  {/if}

  <!-- ── Document Defaults ── -->
  {#if selectedBoard === 'document' && documentDefaults}
    <div class="defaults-section">
      <h4 class="subsection-title">Board</h4>
      <div class="setting-row">
        <span class="setting-label">Background Color</span>
        <ColorPicker value={documentDefaults.backgroundColor} onchange={(c) => update('document.backgroundColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="doc-pattern">Background Pattern</label>
        <select id="doc-pattern" class="setting-select" value={documentDefaults.backgroundPattern} onchange={(e) => update('document.backgroundPattern', (e.target as HTMLSelectElement).value)}>
          {#each BACKGROUND_PATTERN_OPTIONS as p (p)}<option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <span class="setting-label">Accent Color</span>
        <ColorPicker value={documentDefaults.accentColor} onchange={(c) => update('document.accentColor', c)} />
      </div>

      <h4 class="subsection-title">Document Element Defaults</h4>
      <div class="setting-row">
        <span class="setting-label">Body Color</span>
        <ColorPicker value={documentDefaults.document.bodyColor} onchange={(c) => update('document.document.bodyColor', c)} />
      </div>
      <div class="setting-row">
        <span class="setting-label">Border Color</span>
        <ColorPicker value={documentDefaults.document.borderColor} onchange={(c) => update('document.document.borderColor', c)} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="doc-border">Border Style</label>
        <select id="doc-border" class="setting-select" value={documentDefaults.document.borderStyle} onchange={(e) => update('document.document.borderStyle', (e.target as HTMLSelectElement).value)}>
          {#each BORDER_STYLE_OPTIONS as b (b)}<option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>{/each}
        </select>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="doc-bw">Border Width</label>
        <input id="doc-bw" class="setting-input number-input" type="number" min="0" max="10" value={documentDefaults.document.borderWidth} onchange={(e) => setNumber(e.currentTarget, 'document.document.borderWidth')} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="doc-shadow">Shadow Intensity</label>
        <input id="doc-shadow" class="setting-range" type="range" min="0" max="1" step="0.05" value={documentDefaults.document.shadowIntensity} oninput={(e) => update('document.document.shadowIntensity', parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="doc-elem-dct">Dynamic Contrast Text</label>
        <select id="doc-elem-dct" class="setting-select" value={documentDefaults.document.dynamicContrastText ? 'true' : 'false'} onchange={(e) => update('document.document.dynamicContrastText', (e.target as HTMLSelectElement).value === 'true')}>
          <option value="true">Auto contrast</option>
          <option value="false">Use chosen text color</option>
        </select>
      </div>
    </div>
  {/if}
</div>

<style>
  .board-defaults {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .rule-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    margin: 0 0 8px;
    padding: 6px 10px;
    border-left: 3px solid var(--accent-primary-alpha);
    background: var(--ui-bg-secondary);
    border-radius: 3px;
    line-height: 1.5;
  }

  .subsection-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--accent-primary);
    margin: 8px 0 4px;
    padding-top: 8px;
    border-top: 1px solid var(--ui-border);
  }

  .subsection-title:first-of-type {
    border-top: none;
    padding-top: 0;
    margin-top: 0;
  }

  .defaults-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 32px;
  }

  .setting-label {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .setting-select {
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-system);
    cursor: pointer;
    min-width: 120px;
  }

  .setting-select:focus {
    border-color: var(--ui-border-focus);
  }
  .setting-select:focus:not(:focus-visible) {
    outline: none;
  }

  .setting-input {
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-system);
  }

  .setting-input:focus {
    border-color: var(--ui-border-focus);
  }
  .setting-input:focus:not(:focus-visible) {
    outline: none;
  }

  .number-input {
    width: 70px;
    text-align: center;
  }

  .setting-range {
    width: 140px;
    accent-color: var(--accent-primary);
  }

  .setting-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 4px 0;
  }

  .bg-image-row {
    align-items: center;
  }
</style>
