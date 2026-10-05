<script lang="ts">
  /**
   * A text card's body that builds its editor only when it is needed.
   *
   * A TipTap editor per card, all in one flush, froze a large Kanban board
   * on every open and tab switch. Until its card is within about a screen
   * of the column's visible area this shows the note as static HTML
   * (`renderNotePreviewHtml`), laid out like the editor. Near the viewport
   * the real editor is queued on the shared mount queue (a few per frame,
   * cards on screen first); a press or focus on the preview mounts it at
   * once and puts the caret where the press was. Once mounted it stays
   * until the board unmounts.
   *
   * A right-click is not a press into the text: it neither mounts the editor
   * nor moves focus, so the card's menu keeps the keys (`wantsNativeTextMenu`
   * gives the card's menu on text that isn't being edited, loaded or not).
   * Kept from focusing, the preview doesn't mount either.
   *
   * A preview holds no text of its own, so leave / quit / rescue logic needs
   * nothing here: a card without an editor has nothing unsaved, and a
   * mounted one registers through `TextTile` as before.
   */
  import { onMount, onDestroy, flushSync } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import type { TextTile } from '../../schema/index';
  import type { ResolvedTileStyle } from '../../lib/styles/effectiveStyle';
  import TextTileBody from './TextTile.svelte';
  import { noteBody, resolveLineSpacing } from '../../stores/noteMeta';
  import { renderNotePreviewHtml } from '../../lib/editor/staticPreview';
  import { EMPTY_NOTE_PLACEHOLDER } from '../../lib/editor/createEditor';
  import { queueEditorMount } from '../../lib/editor/editorMountQueue';
  import { uiStore } from '../../stores/ui.svelte';
  import { keepFocusOnSecondaryPress } from '../../lib/utils/editableTarget';

  let {
    tile,
    resolved,
  }: {
    tile: TextTile;
    resolved?: ResolvedTileStyle;
  } = $props();

  let host: HTMLDivElement;
  let mounted = $state(false);
  let cancelQueued: (() => void) | null = null;
  let observers: IntersectionObserver[] = [];
  /** Whether the card is in the column's visible area now (it mounts first). */
  let visibleNow = false;
  /** Where to put the caret once the editor has loaded the note. */
  let caretTarget: { x: number; y: number } | 'start' | null = null;

  const notePath = $derived(tile.filePath ?? '');
  // An empty note's stand-in carries the editor's placeholder, as the editor's own empty paragraph does.
  const emptyPreview = `<p class="is-editor-empty" data-placeholder="${EMPTY_NOTE_PLACEHOLDER}"><br></p>`;
  const previewHtml = $derived(mounted ? '' : renderNotePreviewHtml(noteBody(notePath), notePath) || emptyPreview);
  const previewStyle = $derived.by(() => {
    const fs = resolved?.fontSizeBody;
    return `${fs != null ? `font-size: ${fs}px;` : ''}line-height: ${resolveLineSpacing(notePath)};`;
  });

  /** The scrolling list the card sits in (marked `data-lazy-mount-root`); else the viewport. */
  function scrollRoot(): Element | null {
    return host?.parentElement?.closest('[data-lazy-mount-root]') ?? null;
  }

  function mountNow(): void {
    if (mounted) return;
    cancelQueued?.();
    cancelQueued = null;
    for (const o of observers) o.disconnect();
    observers = [];
    mounted = true;
    flushSync();
  }

  function queueMount(): void {
    if (mounted || cancelQueued) return;
    cancelQueued = queueEditorMount(mountNow, () => visibleNow);
  }

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') {
      queueMount();
      return;
    }
    const root = scrollRoot();
    observers = [
      // One root height above and below: a card mounts before it scrolls in.
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) queueMount();
      }, { root, rootMargin: '100% 0px 100% 0px' }),
      new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) visibleNow = last.isIntersecting;
      }, { root }),
    ];
    for (const o of observers) o.observe(host);
  });

  onDestroy(() => {
    cancelQueued?.();
    for (const o of observers) o.disconnect();
  });

  function handlePointerDown(e: PointerEvent): void {
    if (mounted || e.button !== 0) return;
    const onText = (e.target as Element | null)?.closest('.lazy-preview-text');
    caretTarget = onText ? { x: e.clientX, y: e.clientY } : null;
    mountNow();
  }

  function handleFocus(): void {
    if (mounted) return;
    caretTarget = 'start';
    mountNow();
  }

  function handleEditorReady(editor: Editor): void {
    const target = caretTarget;
    caretTarget = null;
    if (!target) return;
    // After this flush's effects, so the editor is editable when it takes focus.
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      // A menu or dialog opened meanwhile keeps its focus (and its keys).
      if (uiStore.contextMenu.visible) return;
      if (document.activeElement?.closest('[role="menu"], [role="dialog"], [aria-modal="true"], dialog')) return;
      if (target === 'start') {
        editor.commands.focus('start');
        return;
      }
      const hit = editor.view.posAtCoords({ left: target.x, top: target.y });
      editor.commands.focus(hit ? hit.pos : 'end');
    });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="lazy-text-body" bind:this={host} data-tile-text="" onmousedown={(e) => keepFocusOnSecondaryPress(e, host)}>
  {#if mounted}
    <TextTileBody {tile} {resolved} onEditorReady={handleEditorReady} />
  {:else}
    <div class="text-tile">
      <!-- A stand-in for the editor: a press or focus swaps the real one in. -->
      <div
        class="editor-container"
        style={previewStyle}
        role="textbox"
        aria-readonly="false"
        aria-multiline="true"
        aria-label="Card text"
        tabindex="0"
        data-note-preview=""
        onpointerdown={handlePointerDown}
        onfocus={handleFocus}
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised in renderNotePreviewHtml -->
        <div class="tiptap lazy-preview-text">{@html previewHtml}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .lazy-text-body {
    width: 100%;
    height: 100%;
  }
  /* Mirrors TextTile's editor box, so the swap moves nothing. */
  .text-tile {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .editor-container {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    outline: none;
    cursor: text;
    font-size: var(--font-size-tile-body, 13px);
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }
  .lazy-preview-text {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
