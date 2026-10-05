import type { Editor } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { toMediaUrl } from '../utils/mediaUrl';
import { toPosix } from '../utils/path';

/**
 * Images a note shows, from the vault.
 *
 * A note embeds an image by an address relative to itself
 * (`![map](images/map.png)`), as Markdown and other apps read it. The page
 * resolved that address against the app's own, and the app loads media only
 * through `filo:`, so the image never showed. The editor now shows each image
 * through the vault's media protocol (`filo://media/…`), resolved from the
 * note's folder (or from the vault's top for an address starting with `/`).
 * What is saved is the address as the file has it: only the shown `<img>`
 * changes, never the node.
 */

/** The note each editor shows, for its images' addresses. */
// allow-module-state: per-editor note path, dropped with the editor (WeakMap)
const notePaths = new WeakMap<Editor, string>();

/** Tells `editor`'s images which note they are in. Call before loading the note into it. */
export function setImageNote(editor: Editor, notePath: string): void {
  notePaths.set(editor, notePath);
}

/** An address with a scheme (`https:`, `data:`, `filo:`) or a host (`//cdn…`): not a file in the vault. */
const NOT_A_VAULT_PATH = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The vault-relative path an image address in the note at `notePath` names,
 * or null when it names no file in the vault (a web address, or a path that
 * climbs above the vault's top).
 */
export function noteImagePath(src: string, notePath: string): string | null {
  if (!src || NOT_A_VAULT_PATH.test(src)) return null;
  const address = toPosix(src.replace(/[?#].*$/, ''));
  if (!address) return null;
  const fromTop = address.startsWith('/');
  const folder = fromTop ? [] : toPosix(notePath).split('/').slice(0, -1);
  const parts = [...folder];
  for (const segment of address.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(decoded(segment));
    }
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * The address the page loads for an image `src` in the note at `notePath`:
 * a vault file through `filo://media/`, anything else as written (the app's
 * security policy decides whether it loads).
 */
export function noteImageUrl(src: string | null | undefined, notePath: string): string {
  if (!src) return '';
  const rel = noteImagePath(src, notePath);
  return rel === null ? src : toMediaUrl(rel);
}

/** The attributes an image node shows, besides its address. */
const SHOWN_ATTRS = ['alt', 'title', 'width', 'height'] as const;

function showImage(img: HTMLImageElement, node: ProseMirrorNode, editor: Editor): void {
  for (const name of SHOWN_ATTRS) {
    const value: unknown = node.attrs[name];
    if (value === null || value === undefined || value === '') img.removeAttribute(name);
    else img.setAttribute(name, String(value));
  }
  const url = noteImageUrl(typeof node.attrs.src === 'string' ? node.attrs.src : '', notePaths.get(editor) ?? '');
  if (url) {
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  } else {
    img.removeAttribute('src');
  }
}

/** TipTap's image, shown from the vault. */
export const NoteImage = Image.extend({
  addNodeView() {
    return ({ node, editor }) => {
      const img = document.createElement('img');
      showImage(img, node, editor);
      return {
        dom: img,
        update: (updated: ProseMirrorNode): boolean => {
          if (updated.type !== node.type) return false;
          showImage(img, updated, editor);
          return true;
        },
      };
    };
  },
});
