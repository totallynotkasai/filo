<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { toolbarStore } from '../../stores/toolbar.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { tiptapToolbar, LINK_REFUSED_MESSAGE } from '../../lib/editor/toolbarConfig';
  import type { Editor } from '@tiptap/core';
  import IconButton from '../shared/IconButton.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import LinkInsertPopup from './LinkInsertPopup.svelte';

  let showTextColorPicker = $state(false);
  let showHighlightColorPicker = $state(false);
  let showLineSpacingMenu = $state(false);
  let textColorBtnRef = $state<HTMLDivElement | null>(null);
  let highlightColorBtnRef = $state<HTMLDivElement | null>(null);
  let lineSpacingBtnRef = $state<HTMLDivElement | null>(null);
  let textColorPanelRef = $state<HTMLDivElement | null>(null);
  let highlightColorPanelRef = $state<HTMLDivElement | null>(null);
  let textColorPanelLeft = $state(0);
  let textColorPanelTop = $state(0);
  let highlightColorPanelLeft = $state(0);
  let highlightColorPanelTop = $state(0);

  let systemFonts = $state<string[]>([]);
  let projectFonts = $derived(
    vaultStore.project?.settings?.general?.systemFonts ?? ['Inter', 'Arial', 'Georgia', 'Courier New', 'Verdana']
  );
  let availableFonts = $derived(
    [...new Set([...systemFonts, ...projectFonts])].sort()
  );

  $effect(() => {
    window.filo.invoke('font:list-system')
      .then((fonts) => {
        if (fonts?.length) systemFonts = fonts;
      })
      .catch(() => {});
  });

  const headingMap: Record<string, 0 | 1 | 2 | 3 | 4 | 5> = {
    normal: 0, h1: 1, h2: 2, h3: 3, h4: 4, h5: 5,
  };

  function handleStyleChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    tiptapToolbar.setHeading(headingMap[value] ?? 0);
  }

  function handleFontChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    tiptapToolbar.setFontFamily(value);
  }

  let showLinkPopup = $state(false);
  let linkPopupX = $state(0);
  let linkPopupY = $state(0);
  let linkInitialUrl = $state('');
  // Captured at the moment the user opens the popup. The popup's input
  // takes focus, which fires the editor's onBlur → schedules a 300ms
  // clearActiveEditor; if the user takes longer than that to type a URL,
  // tiptapToolbar.activeEditor is null at apply time. Holding our own
  // reference here keeps the editor reachable until the popup closes.
  let linkSavedFrom = 0;
  let linkSavedTo = 0;
  let linkSavedEditor: Editor | null = null;

  function openInsertLinkPopupAt(x: number, y: number) {
    tiptapToolbar.keepActiveEditor();
    const editor = tiptapToolbar.activeEditor;
    if (!editor) {
      uiStore.toast('Click into a text tile or document first', 'info');
      return;
    }

    linkSavedEditor = editor;
    const { from, to } = editor.state.selection;
    linkSavedFrom = from;
    linkSavedTo = to;

    const existing = editor.getAttributes('link').href;
    linkInitialUrl = typeof existing === 'string' ? existing : '';

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

  function applyLink(url: string) {
    const editor = linkSavedEditor;
    // Audit-19 UX-1 — a non-editable (read-only / frozen) editor refuses edits.
    if (!editor || !editor.isEditable) return;
    const ok = editor
      .chain()
      .focus()
      .setTextSelection({ from: linkSavedFrom, to: linkSavedTo })
      .extendMarkRange('link')
      .setLink({ href: url })
      .run();
    // Audit-19 UX-2 — surface a refused href (it used to fail silently).
    if (!ok) uiStore.toast(LINK_REFUSED_MESSAGE, 'error');
  }

  function removeLink() {
    const editor = linkSavedEditor;
    if (!editor || !editor.isEditable) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: linkSavedFrom, to: linkSavedTo })
      .extendMarkRange('link')
      .unsetLink()
      .run();
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
    if (showLineSpacingMenu && lineSpacingBtnRef && !lineSpacingBtnRef.contains(target)) {
      showLineSpacingMenu = false;
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
    value={toolbarStore.fontFamily}
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
    <option value="normal">Normal text</option>
    <option value="h1">Title</option>
    <option value="h2">Subtitle</option>
    <option value="h3">Heading 1</option>
    <option value="h4">Heading 2</option>
    <option value="h5">Heading 3</option>
  </select>

  <div class="toolbar-divider"></div>

  <IconButton title="Spelling & Grammar" size="small" active={toolbarStore.spellcheck} pressed={toolbarStore.spellcheck} onclick={() => toolbarStore.toggleSpellcheck()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v18"/><path d="M4 8l4 4 8-8"/><path d="M20 21l-4-4"/><path d="M16 21l4-4"/></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

  <IconButton title="Insert Link (Ctrl+K)" size="small" onclick={handleInsertLink}>
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

  <div class="align-dropdown-wrapper" bind:this={lineSpacingBtnRef}>
    <IconButton title="Line Spacing" size="small" active={showLineSpacingMenu} pressed={showLineSpacingMenu} onclick={() => showLineSpacingMenu = !showLineSpacingMenu}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polyline points="4 6 7 3 7 21 4 18"/></svg>
    </IconButton>
    {#if showLineSpacingMenu}
      <div class="align-panel line-spacing-panel">
        {#each [1.0, 1.15, 1.5, 2.0] as spacing (spacing)}
          <button
            class="align-option"
            class:active={toolbarStore.lineSpacing === spacing}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => { tiptapToolbar.setLineSpacing(spacing); showLineSpacingMenu = false; }}
            title="Line spacing {spacing}"
          >
            {spacing}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="toolbar-divider"></div>

  <IconButton title="Bulleted List" size="small" onclick={() => tiptapToolbar.toggleBulletList()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.5" fill="currentColor"/><circle cx="3.5" cy="12" r="1.5" fill="currentColor"/><circle cx="3.5" cy="18" r="1.5" fill="currentColor"/></svg>
  </IconButton>

  <IconButton title="Numbered List" size="small" onclick={() => tiptapToolbar.toggleOrderedList()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" font-size="8" fill="currentColor" font-family="sans-serif">1</text><text x="2" y="14" font-size="8" fill="currentColor" font-family="sans-serif">2</text><text x="2" y="20" font-size="8" fill="currentColor" font-family="sans-serif">3</text></svg>
  </IconButton>

  <div class="toolbar-divider"></div>

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
    initialUrl={linkInitialUrl}
    onApply={applyLink}
    onRemove={removeLink}
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
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
    appearance: none;
  }

  .toolbar-select:hover {
    background-color: var(--ui-surface-hover);
    border-color: var(--ui-border-light);
  }

  .toolbar-select:focus-visible {
    border-color: var(--accent-primary);
    outline: none;
  }

  .font-select {
    width: 100px;
  }

  .style-select {
    width: 110px;
  }

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
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .size-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .size-value {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    font-size: 12px;
    color: var(--text-primary);
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
    color: var(--text-secondary);
    cursor: pointer;
    gap: 1px;
    transition: background-color 0.1s ease;
  }

  .toolbar-color-btn:hover {
    background: var(--ui-surface-hover);
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

  .align-dropdown-wrapper {
    position: relative;
  }

  .line-spacing-panel .align-option {
    width: auto;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .line-spacing-panel .align-option.active {
    color: var(--accent-primary);
    font-weight: 600;
  }
</style>
