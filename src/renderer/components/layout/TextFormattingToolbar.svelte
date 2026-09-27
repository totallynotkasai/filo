<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { toolbarStore } from '../../stores/toolbar.svelte';
  import { LINE_SPACING_CHOICES, formatLineSpacing, noteLineSpacing, projectLineSpacing } from '../../stores/noteMeta';
  import { uiStore } from '../../stores/ui.svelte';
  import { tiptapToolbar, LINK_IN_CODE_MESSAGE, LINK_REFUSED_MESSAGE } from '../../lib/editor/toolbarConfig';
  import { applyLink, linkAllowedAt, linkTargetAt, removeLink, type LinkTarget } from '../../lib/editor/insertLink';
  import { normaliseLinkUrl } from '../../lib/editor/linkUrl';
  import type { Editor } from '@tiptap/core';
  import IconButton from '../shared/IconButton.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import LinkInsertPopup from './LinkInsertPopup.svelte';
  import { fontFromStack } from '../../../shared/fontStack';
  import { GENERAL_SETTINGS_DEFAULTS } from '../../../shared/generalSettingsDefaults';

  let showTextColorPicker = $state(false);
  let showHighlightColorPicker = $state(false);
  let textColorBtnRef = $state<HTMLDivElement | null>(null);
  let highlightColorBtnRef = $state<HTMLDivElement | null>(null);
  let textColorPanelRef = $state<HTMLDivElement | null>(null);
  let highlightColorPanelRef = $state<HTMLDivElement | null>(null);
  let textColorPanelLeft = $state(0);
  let textColorPanelTop = $state(0);
  let highlightColorPanelLeft = $state(0);
  let highlightColorPanelTop = $state(0);

  let systemFonts = $state<string[]>([]);
  let projectFonts = $derived(
    vaultStore.project?.settings?.general?.systemFonts ?? GENERAL_SETTINGS_DEFAULTS.systemFonts
  );
  // The font the selection is shown in: its own font mark, else the global font.
  let shownFont = $derived(fontFromStack(
    toolbarStore.fontFamily || (vaultStore.project?.settings?.general?.globalFont ?? GENERAL_SETTINGS_DEFAULTS.globalFont)
  ));
  // The shown font is always listed, so the box never goes blank for a font
  // the lists don't name (a mark pasted in, or a font typed into a file).
  let availableFonts = $derived(
    [...new Set([...systemFonts, ...projectFonts, shownFont].filter(Boolean))].sort()
  );

  $effect(() => {
    window.filo.invoke('font:list-system')
      .then((fonts) => {
        if (fonts?.length) systemFonts = fonts;
      })
      .catch(() => {});
  });

  // Each option maps straight to its HTML heading level, so the file's `#`
  // count matches the label. The option classes preview each size.
  const HEADING_OPTIONS: ReadonlyArray<{ value: string; label: string; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }> = [
    { value: 'normal', label: 'Normal text', level: 0 },
    { value: 'h1', label: 'Heading 1', level: 1 },
    { value: 'h2', label: 'Heading 2', level: 2 },
    { value: 'h3', label: 'Heading 3', level: 3 },
    { value: 'h4', label: 'Heading 4', level: 4 },
    { value: 'h5', label: 'Heading 5', level: 5 },
    { value: 'h6', label: 'Heading 6', level: 6 },
  ];

  function handleStyleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const applied = tiptapToolbar.setHeading(HEADING_OPTIONS.find((o) => o.value === select.value)?.level ?? 0);
    // A refused change leaves the store as it was, so `value={…}` never
    // re-renders: put the block's real level back by hand.
    if (!applied) select.value = toolbarStore.heading;
  }

  // Line spacing is the note's own `lineSpacing:`, or "Default" (none: the
  // note follows Settings → General, whose value the option shows).
  const LINE_SPACING_DEFAULT = 'default';
  // Read from the note itself, so an undo or another view's change shows at once.
  let noteSpacing = $derived(toolbarStore.lineSpacingNote ? noteLineSpacing(toolbarStore.lineSpacingNote) : null);
  let lineSpacingValue = $derived(noteSpacing === null ? LINE_SPACING_DEFAULT : String(noteSpacing));
  // A value typed into the file by hand that the list doesn't offer still shows.
  let lineSpacingIsCustom = $derived(
    noteSpacing !== null && !LINE_SPACING_CHOICES.includes(noteSpacing)
  );
  let lineSpacingTitle = $derived(
    toolbarStore.lineSpacingAvailable ? 'Line Spacing (whole note)' : 'Click inside a note to set line spacing'
  );

  function handleLineSpacingChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const value = select.value === LINE_SPACING_DEFAULT ? null : Number(select.value);
    tiptapToolbar.setLineSpacing(value);
    // A refused change (the note isn't editable) leaves the note as it was:
    // put the note's real value back by hand.
    select.value = lineSpacingValue;
  }

  function handleFontChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    tiptapToolbar.setFontFamily(value);
  }

  let showLinkPopup = $state(false);
  let linkPopupX = $state(0);
  let linkPopupY = $state(0);
  // Captured at the moment the user opens the popup. The popup's input
  // takes focus, which fires the editor's onBlur → schedules a 300ms
  // clearActiveEditor; if the user takes longer than that to type a URL,
  // tiptapToolbar.activeEditor is null at apply time. Holding our own
  // reference here keeps the editor reachable until the popup closes.
  let linkTarget = $state<LinkTarget>({ from: 0, to: 0, text: '', href: '' });
  let linkSavedEditor: Editor | null = null;

  function openInsertLinkPopupAt(x: number, y: number) {
    tiptapToolbar.keepActiveEditor();
    const editor = tiptapToolbar.activeEditor;
    if (!editor) {
      uiStore.toast('Click into a text tile or document first', 'info');
      return;
    }
    if (!editor.isEditable) {
      uiStore.toast("This note can't be edited right now", 'info');
      return;
    }
    // Titles and connection labels have no link mark.
    if (!editor.schema.marks.link) {
      uiStore.toast("Links can't be added to a title or label", 'info');
      return;
    }

    linkSavedEditor = editor;
    linkTarget = linkTargetAt(editor);

    linkPopupX = x;
    linkPopupY = y;
    showLinkPopup = true;
  }

  function handleInsertLink(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openInsertLinkPopupAt(rect.left, rect.bottom + 4);
  }

  // Expose the open-popup handler to the Ctrl+K command (and any other
  // non-toolbar trigger). tiptapToolbar.requestInsertLink computes a caret
  // anchor when no anchor is supplied and forwards here.
  $effect(() => {
    tiptapToolbar.setOpenInsertLinkPopup((anchor) => openInsertLinkPopupAt(anchor.x, anchor.y));
    return () => tiptapToolbar.setOpenInsertLinkPopup(null);
  });

  /** Returns the error the popup shows, or null once the link is in. */
  function handleApplyLink(text: string, url: string): string | null {
    const editor = linkSavedEditor;
    if (!editor || !editor.isEditable) return "This note can't be edited right now.";
    // Where the link goes is checked apart from its URL: no URL would help in
    // a code block, so the message must not ask for a different one.
    if (!linkAllowedAt(editor, linkTarget)) return LINK_IN_CODE_MESSAGE;
    const href = normaliseLinkUrl(url);
    // A refused href is said, never dropped silently.
    if (!href || !applyLink(editor, linkTarget, text, href)) return LINK_REFUSED_MESSAGE;
    return null;
  }

  function handleRemoveLink() {
    if (linkSavedEditor) removeLink(linkSavedEditor, linkTarget);
  }

  function closeLinkPopup() {
    showLinkPopup = false;
    linkSavedEditor = null;
  }

  function handleDocClick(e: MouseEvent) {
    const target = e.target as Node;
    if (showTextColorPicker && textColorBtnRef && !textColorBtnRef.contains(target) &&
        (!textColorPanelRef || !textColorPanelRef.contains(target))) {
      showTextColorPicker = false;
    }
    if (showHighlightColorPicker && highlightColorBtnRef && !highlightColorBtnRef.contains(target) &&
        (!highlightColorPanelRef || !highlightColorPanelRef.contains(target))) {
      showHighlightColorPicker = false;
    }
  }

  $effect(() => {
    document.addEventListener('click', handleDocClick, true);
    return () => document.removeEventListener('click', handleDocClick, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="toolbar-section formatting" onmousedown={() => tiptapToolbar.keepActiveEditor()}>
  <select
    class="toolbar-select font-select"
    title="Font Family"
    aria-label="Font family"
    value={shownFont}
    onfocus={() => tiptapToolbar.keepActiveEditor()}
    onchange={handleFontChange}
  >
    {#each availableFonts as font (font)}
      <option value={font} style="font-family: {font}">{font}</option>
    {/each}
  </select>

  <div class="font-size-control">
    <button class="size-btn" title="Decrease font size" aria-label="Decrease font size" onmousedown={(e) => e.preventDefault()} onclick={() => tiptapToolbar.decreaseFontSize()}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <span class="size-value">{toolbarStore.fontSize}</span>
    <button class="size-btn" title="Increase font size" aria-label="Increase font size" onmousedown={(e) => e.preventDefault()} onclick={() => tiptapToolbar.increaseFontSize()}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <IconButton title="Bold (Ctrl+B)" active={toolbarStore.bold} pressed={toolbarStore.bold} size="small" onclick={() => tiptapToolbar.toggleBold()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
  </IconButton>

  <IconButton title="Italic (Ctrl+I)" active={toolbarStore.italic} pressed={toolbarStore.italic} size="small" onclick={() => tiptapToolbar.toggleItalic()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
  </IconButton>

  <IconButton title="Underline (Ctrl+U)" active={toolbarStore.underline} pressed={toolbarStore.underline} size="small" onclick={() => tiptapToolbar.toggleUnderline()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

  <div class="color-picker-inline" bind:this={textColorBtnRef}>
    <button class="toolbar-color-btn" title="Text Color" aria-label="Text color" onmousedown={(e) => e.preventDefault()} onclick={() => {
      if (!showTextColorPicker && textColorBtnRef) {
        const rect = textColorBtnRef.getBoundingClientRect();
        textColorPanelLeft = rect.left + rect.width / 2;
        textColorPanelTop = rect.bottom + 4;
      }
      showTextColorPicker = !showTextColorPicker;
      if (showTextColorPicker) showHighlightColorPicker = false;
    }}>
      <span class="color-a">A</span>
      <span class="color-bar" style="background: {toolbarStore.textColor};"></span>
    </button>
  </div>

  <div class="color-picker-inline" bind:this={highlightColorBtnRef}>
    <button class="toolbar-color-btn" title="Highlight Color" aria-label="Highlight color" onmousedown={(e) => e.preventDefault()} onclick={() => {
      if (!showHighlightColorPicker && highlightColorBtnRef) {
        const rect = highlightColorBtnRef.getBoundingClientRect();
        highlightColorPanelLeft = rect.left + rect.width / 2;
        highlightColorPanelTop = rect.bottom + 4;
      }
      showHighlightColorPicker = !showHighlightColorPicker;
      if (showHighlightColorPicker) showTextColorPicker = false;
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <span class="color-bar" style="background: {toolbarStore.highlightColor};"></span>
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <select
    class="toolbar-select style-select"
    title="Text Style"
    aria-label="Text style"
    value={toolbarStore.heading}
    onfocus={() => tiptapToolbar.keepActiveEditor()}
    onchange={handleStyleChange}
  >
    {#each HEADING_OPTIONS as option (option.value)}
      <option value={option.value} class="style-option-{option.value}">{option.label}</option>
    {/each}
  </select>

  <div class="toolbar-divider"></div>

  <IconButton title="Spelling & Grammar" size="small" active={toolbarStore.spellcheck} pressed={toolbarStore.spellcheck} onclick={() => toolbarStore.toggleSpellcheck()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v18"/><path d="M4 8l4 4 8-8"/><path d="M20 21l-4-4"/><path d="M16 21l4-4"/></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

  <IconButton title={toolbarStore.link ? 'Edit Link (Ctrl+K)' : 'Insert Link (Ctrl+K)'} active={toolbarStore.link} pressed={toolbarStore.link} size="small" onclick={handleInsertLink}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
  </IconButton>

  <select
    class="toolbar-select align-select"
    title="Text Align"
    aria-label="Text alignment"
    value={toolbarStore.textAlign}
    onfocus={() => tiptapToolbar.keepActiveEditor()}
    onchange={(e) => tiptapToolbar.setTextAlign((e.target as HTMLSelectElement).value as 'left' | 'center' | 'right' | 'justify')}
  >
    <option value="left">Align Left</option>
    <option value="center">Align Center</option>
    <option value="right">Align Right</option>
    <option value="justify">Justify</option>
  </select>

  <div class="toolbar-divider"></div>

  <IconButton title="Bulleted List" size="small" onclick={() => tiptapToolbar.toggleBulletList()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.5" fill="currentColor"/><circle cx="3.5" cy="12" r="1.5" fill="currentColor"/><circle cx="3.5" cy="18" r="1.5" fill="currentColor"/></svg>
  </IconButton>

  <IconButton title="Numbered List" size="small" onclick={() => tiptapToolbar.toggleOrderedList()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" font-size="8" fill="currentColor" font-family="sans-serif">1</text><text x="2" y="14" font-size="8" fill="currentColor" font-family="sans-serif">2</text><text x="2" y="20" font-size="8" fill="currentColor" font-family="sans-serif">3</text></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

  <div class="line-spacing-control" title={lineSpacingTitle}>
    <svg class="line-spacing-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polyline points="4 6 7 3 7 21 4 18"/></svg>
    <select
      class="toolbar-select line-spacing-select"
      title={lineSpacingTitle}
      aria-label="Line spacing (whole note)"
      disabled={!toolbarStore.lineSpacingAvailable}
      value={lineSpacingValue}
      onfocus={() => tiptapToolbar.keepActiveEditor()}
      onchange={handleLineSpacingChange}
    >
      <option value={LINE_SPACING_DEFAULT}>Default ({formatLineSpacing(projectLineSpacing())})</option>
      {#if lineSpacingIsCustom}
        <option value={lineSpacingValue}>{lineSpacingValue}</option>
      {/if}
      {#each LINE_SPACING_CHOICES as spacing (spacing)}
        <option value={String(spacing)}>{formatLineSpacing(spacing)}</option>
      {/each}
    </select>
  </div>

  <IconButton title="Decrease Indent" size="small" onclick={() => tiptapToolbar.decreaseIndent()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polyline points="7 15 3 12 7 9"/></svg>
  </IconButton>

  <IconButton title="Increase Indent" size="small" onclick={() => tiptapToolbar.increaseIndent()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polyline points="3 9 7 12 3 15"/></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

  <IconButton title="Clear Formatting" size="small" onclick={() => tiptapToolbar.clearFormatting()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/><line x1="3" y1="21" x2="21" y2="3" stroke-width="1.5"/></svg>
  </IconButton>
</div>

{#if showTextColorPicker}
  <div
    class="toolbar-color-panel-fixed"
    bind:this={textColorPanelRef}
    style="left: {textColorPanelLeft}px; top: {textColorPanelTop}px;"
  >
    <ColorPicker
      value={toolbarStore.textColor}
      expanded={true}
      onchange={(color) => { tiptapToolbar.setTextColor(color); showTextColorPicker = false; }}
    />
  </div>
{/if}
{#if showHighlightColorPicker}
  <div
    class="toolbar-color-panel-fixed"
    bind:this={highlightColorPanelRef}
    style="left: {highlightColorPanelLeft}px; top: {highlightColorPanelTop}px;"
  >
    <ColorPicker
      value={toolbarStore.highlightColor === 'transparent' ? '' : toolbarStore.highlightColor}
      expanded={true}
      onchange={(color) => { tiptapToolbar.setHighlightColor(color || 'transparent'); showHighlightColorPicker = false; }}
    />
  </div>
{/if}

{#if showLinkPopup}
  <LinkInsertPopup
    x={linkPopupX}
    y={linkPopupY}
    initialText={linkTarget.text}
    initialUrl={linkTarget.href}
    onApply={handleApplyLink}
    onRemove={handleRemoveLink}
    onClose={closeLinkPopup}
  />
{/if}

<style>
  .toolbar-section {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-section.formatting {
    flex: 1;
    justify-content: center;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .toolbar-section.formatting::-webkit-scrollbar {
    display: none;
  }

  .toolbar-divider {
    width: 1px;
    height: 24px;
    background: var(--toolbar-divider, var(--ui-border));
    margin: 0 6px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .toolbar-select {
    padding: 4px 20px 4px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%235f6368' stroke-width='2.5'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 4px center;
    color: var(--chrome-fg, var(--text-primary));
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
    appearance: none;
  }

  /* The native option list has its own light or dark surface. */
  .toolbar-select option {
    color: var(--text-primary);
    background: var(--menu-bg);
  }

  .toolbar-select:hover {
    background-color: var(--chrome-hover, var(--ui-surface-hover));
    border-color: var(--ui-border-light);
  }

  .toolbar-select:focus-visible {
    border-color: var(--accent-primary);
    outline: none;
  }

  /* Wide enough for the default font's name, "Arial Rounded MT", in full. */
  .font-select {
    width: 136px;
  }

  .style-select {
    width: 110px;
  }

  /* Each option previews its level, on the same scale as `.tiptap h1…h6` in
     style.css (a 13px base). The native popup honours font size and weight. */
  .style-select option {
    font-size: 13px;
    font-weight: 400;
  }
  .style-select .style-option-h1 { font-size: 26px; font-weight: 700; }
  .style-select .style-option-h2 { font-size: 21px; font-weight: 700; }
  .style-select .style-option-h3 { font-size: 17.5px; font-weight: 600; }
  .style-select .style-option-h4 { font-size: 15px; font-weight: 600; }
  .style-select .style-option-h5 { font-size: 13px; font-weight: 700; }
  .style-select .style-option-h6 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }

  .font-size-control {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    overflow: hidden;
    transition: border-color 0.1s ease;
  }

  .font-size-control:hover {
    border-color: var(--ui-border);
  }

  .size-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--chrome-fg-muted, var(--text-secondary));
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .size-btn:hover {
    background: var(--chrome-hover, var(--ui-surface-hover));
    color: var(--chrome-fg, var(--text-primary));
  }

  .size-value {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    font-size: 12px;
    color: var(--chrome-fg, var(--text-primary));
  }

  .toolbar-color-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--chrome-fg-muted, var(--text-secondary));
    cursor: pointer;
    gap: 1px;
    transition: background-color 0.1s ease;
  }

  .toolbar-color-btn:hover {
    background: var(--chrome-hover, var(--ui-surface-hover));
  }

  .color-a {
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }

  .color-bar {
    width: 16px;
    height: 3px;
    border-radius: 1px;
  }

  .color-picker-inline {
    position: relative;
    display: inline-flex;
  }

  .toolbar-color-panel-fixed {
    position: fixed;
    transform: translateX(-50%);
    z-index: var(--z-context-menu-overlay);
    padding: 12px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    animation: fadeIn 0.1s ease;
  }

  .align-select {
    width: 105px;
  }

  /* The line-spacing select keeps its icon as a leading glyph, so it reads as
     line spacing and not as another font-size box. Wide enough for
     "Default (1.75)". */
  .line-spacing-control {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .line-spacing-glyph {
    position: absolute;
    left: 6px;
    color: var(--text-secondary);
    pointer-events: none;
  }

  .line-spacing-select {
    width: 118px;
    padding-left: 24px;
  }

  .toolbar-select:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .toolbar-select:disabled:hover {
    background-color: transparent;
    border-color: transparent;
  }

  .line-spacing-control:has(.line-spacing-select:disabled) .line-spacing-glyph {
    opacity: 0.45;
  }
</style>
