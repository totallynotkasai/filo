import { isMacOS } from '@tiptap/core';
import { isFiloLink } from '../../schema/link';
import { linksStore } from '../../stores/links.svelte';
import { asSafeOpenExternal } from '../../../shared/untrusted';

/** The tooltip line on a link that can be opened. */
export const LINK_OPEN_HINT = isMacOS() ? 'Cmd+click to open' : 'Ctrl+click to open';

/** Schemes a click hands to the OS: browser, mail client, dialler. */
const EXTERNAL_RE = /^(https?:\/\/|mailto:|tel:)/i;

function editableEditorOf(el: Element): HTMLElement | null {
  const pm = el.closest('.ProseMirror');
  return pm instanceof HTMLElement && pm.getAttribute('contenteditable') === 'true' ? pm : null;
}

function isOpenable(href: string): boolean {
  return isFiloLink(href) || (EXTERNAL_RE.test(href) && asSafeOpenExternal(href) !== null);
}

/**
 * Opens a link: `filo://` inside the app, the external schemes through the
 * `media:open-external` IPC. `mailto:` / `tel:` must be matched too, or the
 * click would navigate the renderer (possibly losing unsaved state).
 * `asSafeOpenExternal` is the renderer-side gate; the main handler re-checks.
 * Returns false for anything else, which is left alone.
 */
function openLink(href: string): boolean {
  if (isFiloLink(href)) {
    linksStore.handleLinkClick(href);
    return true;
  }
  if (!EXTERNAL_RE.test(href)) return false;
  const safe = asSafeOpenExternal(href);
  if (!safe) return false;
  // allow-envelope-bare: fire-and-forget click handler; failure is
  // user-visible (browser doesn't open) and not worth a toast.
  void window.filo.invoke('media:open-external', safe);
  return true;
}

/**
 * Link clicks across the app (capture phase, so no view handles them first).
 *
 * In an editor that was already being edited when the pointer went down, a
 * plain click only places the caret, so a link's text can be edited; Ctrl+click
 * (Cmd on macOS) opens it. Everywhere else (a read-only note, a tile not being
 * edited, a link tile, search results) a plain click opens the link.
 *
 * Hovering a link in an editor shows its URL and the Ctrl+click hint. The
 * tooltip is set on the editor's parent, outside ProseMirror's DOM: an
 * attribute change inside it would be read back into the document.
 *
 * Returns the uninstaller.
 */
export function installLinkClickHandling(doc: Document = document): () => void {
  // The editor that held focus when the last pointer went down: focus moves
  // into an editor on pointerdown, so it can't be read at click time.
  let editingAtPointerDown: HTMLElement | null = null;

  function onPointerDown(e: PointerEvent | MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const pm = target ? editableEditorOf(target) : null;
    editingAtPointerDown = pm && pm.contains(doc.activeElement) ? pm : null;
  }

  function onClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const anchor = target?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href) return;
    const pm = editableEditorOf(anchor);
    if (pm && pm === editingAtPointerDown && !(e.ctrlKey || e.metaKey)) {
      // The caret is placed on pointerdown; only stop the navigation.
      e.preventDefault();
      return;
    }
    if (openLink(href)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  let tooltipHost: HTMLElement | null = null;
  let hostTitle: string | null = null;

  function clearTooltip(): void {
    if (!tooltipHost) return;
    if (hostTitle === null) tooltipHost.removeAttribute('title');
    else tooltipHost.setAttribute('title', hostTitle);
    tooltipHost = null;
    hostTitle = null;
  }

  function onMouseOver(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const anchor = target?.closest('.ProseMirror a[href]');
    const host = anchor?.closest('.ProseMirror')?.parentElement ?? null;
    if (!anchor || !host) {
      clearTooltip();
      return;
    }
    if (tooltipHost !== host) {
      clearTooltip();
      tooltipHost = host;
      hostTitle = host.getAttribute('title');
    }
    const href = anchor.getAttribute('href') ?? '';
    host.setAttribute('title', isOpenable(href) ? `${href}\n${LINK_OPEN_HINT}` : href);
  }

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('mouseover', onMouseOver, true);
  return () => {
    clearTooltip();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('mouseover', onMouseOver, true);
  };
}
