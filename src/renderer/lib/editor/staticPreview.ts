import MarkdownIt from 'markdown-it';
import { sanitizeNoteHtml } from '../utils/sanitizeHtml';
import { renderSoftBreaksAsNodes } from './softBreak';
import { noteImageUrl } from './noteImages';
import { keepEscapedCharactersInImageAlt } from './imageAlt';
import { toPosix } from '../utils/path';
import { EMPTY_PARAGRAPH_SENTINEL, encodeEmptyParagraphs } from './emptyParagraphs';

/**
 * A note body as static HTML, for a Kanban card whose editor isn't mounted
 * yet (`LazyTextTileBody`). Building a TipTap editor per card is what made a
 * large board freeze on open; a preview costs one markdown-it render.
 *
 * Parsed like the editor parses (markdown-it, HTML on, GFM tables), and laid
 * out like the editor renders, so the swap to the real editor doesn't move
 * anything: the caller wraps it in the editor's `.tiptap` content class, and
 * checklists get TipTap's task-item structure. The output is sanitised; it is
 * the user's file, but it goes into `innerHTML`.
 *
 * Read-only by construction: nothing here writes, and the checkboxes are
 * disabled. The first click mounts the real editor. Images show as the
 * editor shows them, from the vault (`noteImages.ts`); the sanitiser keeps an
 * image only with a `filo://media/` address, so a preview loads nothing else.
 */

const md = new MarkdownIt({ html: true, linkify: false, breaks: false });
// A single newline inside a paragraph shows as a line break, as in the editor.
renderSoftBreaksAsNodes(md);
// An image's alt text as the editor reads it.
keepEscapedCharactersInImageAlt(md);

/** Rendered previews by note folder and body text; a board re-renders the same bodies on every open. */
const CACHE_LIMIT = 1000;
// allow-module-state: a bounded render cache of pure output, keyed by the input text
const cache = new Map<string, string>();

const TASK_MARKER = /^\[( |x|X)\][ \t]/;

/** The first text node inside `el`, skipping empty ones. */
function firstText(el: Element): Text | null {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? '') !== '') return n as Text;
  }
  return null;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CONTAINER_TAGS = new Set(['DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);

/**
 * The editor's DOM has no whitespace between blocks; markdown-it leaves
 * newlines there (and in HTML the note holds), which the editor's `pre-wrap`
 * would show as blank lines. Code blocks keep theirs.
 */
function normaliseWhitespace(root: HTMLElement): void {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    if (t.parentElement?.closest('pre')) continue;
    const value = t.textContent ?? '';
    if (!value.includes('\n')) continue;
    if (value.trim() === '' && CONTAINER_TAGS.has(t.parentElement?.tagName ?? '')) t.remove();
    else t.textContent = value.replace(/\n/g, ' ');
  }
}

/** A list item or table cell holds paragraphs in the editor, never bare text. */
function wrapInlineRuns(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('li, td, th'))) {
    let run: ChildNode[] = [];
    const flush = (before: ChildNode | null): void => {
      if (run.length === 0) return;
      const p = el.ownerDocument.createElement('p');
      el.insertBefore(p, before);
      for (const n of run) p.appendChild(n);
      run = [];
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) flush(child);
      else run.push(child);
    }
    flush(null);
  }
}

/** A list whose every item opens with `[ ] ` / `[x] ` becomes TipTap's task list. */
function toTaskLists(root: HTMLElement): void {
  for (const ul of Array.from(root.querySelectorAll('ul'))) {
    const items = Array.from(ul.children).filter((c) => c.tagName === 'LI');
    if (items.length === 0) continue;
    const markers = items.map((li) => {
      const t = firstText(li);
      const m = t ? TASK_MARKER.exec(t.textContent ?? '') : null;
      return m && t ? { t, checked: m[1] !== ' ', len: m[0].length } : null;
    });
    if (markers.some((m) => m === null)) continue;
    ul.setAttribute('data-type', 'taskList');
    items.forEach((li, i) => {
      const m = markers[i];
      if (!m) return;
      m.t.textContent = (m.t.textContent ?? '').slice(m.len);
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', String(m.checked));
      const doc = li.ownerDocument;
      const label = doc.createElement('label');
      const box = doc.createElement('input');
      // Attributes, not properties: the result is serialised through innerHTML.
      box.setAttribute('type', 'checkbox');
      box.setAttribute('disabled', '');
      if (m.checked) box.setAttribute('checked', '');
      label.appendChild(box);
      const content = doc.createElement('div');
      while (li.firstChild) content.appendChild(li.firstChild);
      li.append(label, content);
    });
  }
}

/**
 * A blank line the user typed is an empty paragraph in the editor, a line high
 * (paragraphs have no gap between them, so nothing else shows it). The body
 * went through `encodeEmptyParagraphs` as the editor's load does; each
 * sentinel paragraph becomes the editor's empty one.
 */
function showEmptyParagraphs(root: HTMLElement): void {
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (p.textContent === EMPTY_PARAGRAPH_SENTINEL) p.replaceChildren(p.ownerDocument.createElement('br'));
  }
}

/** `html` with each image's address made the one the editor shows it from. */
function withVaultImages(html: string, notePath: string): string {
  if (!html.includes('<img')) return html;
  // A template's content is inert: nothing in it loads.
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const img of Array.from(template.content.querySelectorAll('img'))) {
    const url = noteImageUrl(img.getAttribute('src'), notePath);
    if (url) img.setAttribute('src', url);
    else img.remove();
  }
  return template.innerHTML;
}

/**
 * The note body (no frontmatter) as sanitised HTML in the editor's layout.
 * `notePath` is the note's vault path, which its images' addresses resolve from.
 */
export function renderNotePreviewHtml(body: string, notePath = ''): string {
  const folder = toPosix(notePath).split('/').slice(0, -1).join('/');
  const key = `${folder}\u0000${body}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    const template = document.createElement('template');
    // A body already holding the sentinel is left as written, as the editor's load leaves it.
    const source = body.includes(EMPTY_PARAGRAPH_SENTINEL) ? body : encodeEmptyParagraphs(body, md);
    template.innerHTML = sanitizeNoteHtml(withVaultImages(md.render(source), notePath));
    const wrap = document.createElement('div');
    wrap.appendChild(template.content);
    normaliseWhitespace(wrap);
    wrapInlineRuns(wrap);
    toTaskLists(wrap);
    if (source !== body) showEmptyParagraphs(wrap);
    html = wrap.innerHTML;
  } catch {
    // A body markdown-it can't render still shows as its text.
    const p = document.createElement('p');
    p.textContent = body;
    html = p.outerHTML;
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
  return html;
}
