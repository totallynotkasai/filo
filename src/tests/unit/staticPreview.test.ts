import { describe, it, expect } from 'vitest';
import { renderNotePreviewHtml } from '@renderer/lib/editor/staticPreview';
import { EMPTY_PARAGRAPH_SENTINEL } from '@renderer/lib/editor/emptyParagraphs';

function dom(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('renderNotePreviewHtml', () => {
  it('renders Markdown as the editor lays it out', () => {
    const d = dom(renderNotePreviewHtml('# Title\n\nSome **bold** and *it*.\n\n- one\n- two\n'));
    expect(d.querySelector('h1')?.textContent).toBe('Title');
    expect(d.querySelector('strong')?.textContent).toBe('bold');
    // A list item holds a paragraph, as in the editor.
    expect(d.querySelectorAll('li > p').length).toBe(2);
  });

  it('keeps no newlines between blocks and shows a soft break as a line break, as the editor does', () => {
    const html = renderNotePreviewHtml('first line\nsecond line\n\n- a\n- b\n');
    expect(html).not.toContain('\n');
    expect(dom(html).querySelector('p')?.innerHTML).toMatch(/^first line<br[^>]*>second line$/);
  });

  it('keeps a code block as written', () => {
    const d = dom(renderNotePreviewHtml('```\nline 1\n  line 2\n```\n'));
    expect(d.querySelector('pre')?.textContent).toBe('line 1\n  line 2\n');
  });

  it("gives a checklist TipTap's task-list structure, disabled", () => {
    const d = dom(renderNotePreviewHtml('- [ ] open\n- [x] done\n'));
    const ul = d.querySelector('ul');
    expect(ul?.getAttribute('data-type')).toBe('taskList');
    const items = d.querySelectorAll('li[data-type="taskItem"]');
    expect(items.length).toBe(2);
    expect(items[0]?.getAttribute('data-checked')).toBe('false');
    expect(items[1]?.getAttribute('data-checked')).toBe('true');
    const boxes = d.querySelectorAll<HTMLInputElement>('li > label > input[type="checkbox"]');
    expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([[false, true], [true, true]]);
    expect(items[0]?.querySelector('div')?.textContent).toBe('open');
  });

  it('leaves a list with a plain item as a plain list', () => {
    const d = dom(renderNotePreviewHtml('- [ ] task\n- plain\n'));
    expect(d.querySelector('ul')?.getAttribute('data-type')).toBeNull();
  });

  it('renders a table and keeps its alignment', () => {
    const d = dom(renderNotePreviewHtml('| a | b |\n| :-: | --: |\n| 1 | 2 |\n'));
    expect(d.querySelectorAll('td').length).toBe(2);
    expect(d.querySelector('td p')?.textContent).toBe('1');
  });

  it('sanitises: no scripts, handlers or javascript: links', () => {
    const html = renderNotePreviewHtml(
      'text <script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[x](javascript:alert(3)) <b onclick="alert(4)">b</b>\n',
    );
    expect(html).not.toMatch(/<script|onerror|onclick|href="javascript:/i);
    expect(dom(html).querySelector('b')?.textContent).toBe('b');
  });

  it('shows an image from the vault, its address resolved from the note\'s folder', () => {
    const d = dom(renderNotePreviewHtml('The realm:\n\n![map](images/World%20Map.png)\n', 'Notes/Chapter.md'));
    const img = d.querySelector('img');
    expect(img?.getAttribute('src')).toBe('filo://media/Notes/images/World%20Map.png');
    expect(img?.getAttribute('alt')).toBe('map');
  });

  it('loads no image from outside the vault: a web, data or script address leaves no image', () => {
    const html = renderNotePreviewHtml(
      '![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA) <img src="javascript:alert(1)"> ![c](../../../x.png)\n',
      'Notes/A.md',
    );
    expect(dom(html).querySelectorAll('img[src]').length).toBe(0);
    expect(html).not.toMatch(/example\.com|data:|javascript:/);
  });

  it('caches by the note\'s folder too: the same body in another folder shows its own image', () => {
    const body = '![m](map.png)\n';
    expect(dom(renderNotePreviewHtml(body, 'A/n.md')).querySelector('img')?.getAttribute('src')).toBe('filo://media/A/map.png');
    expect(dom(renderNotePreviewHtml(body, 'B/n.md')).querySelector('img')?.getAttribute('src')).toBe('filo://media/B/map.png');
  });

  it('keeps a font size and an indented line, as the editor shows them', () => {
    const d = dom(renderNotePreviewHtml(
      'A <span style="font-size: 20px">big</span> word.\n\n<p style="margin-left: 48px">Indented twice.</p>\n',
    ));
    expect(d.querySelector('span')?.getAttribute('style')).toBe('font-size: 20px');
    const indented = [...d.querySelectorAll('p')].find((p) => p.textContent === 'Indented twice.');
    expect(indented?.getAttribute('style')).toBe('margin-left: 48px');
  });

  it('shows a blank line the user typed as an empty paragraph, as the editor does', () => {
    const d = dom(renderNotePreviewHtml('Line 1\n\nLine 2\n\n\nLine 3\n'));
    const paragraphs = [...d.querySelectorAll('p')];
    expect(paragraphs.map((p) => p.textContent)).toEqual(['Line 1', 'Line 2', '', 'Line 3']);
    expect(paragraphs[2]?.innerHTML).toBe('<br>');
    expect(d.innerHTML).not.toContain(EMPTY_PARAGRAPH_SENTINEL);
  });

  it('resolves a reference link whose definition sits between paragraphs, as the editor does', () => {
    const d = dom(renderNotePreviewHtml('See [the map][m] here.\n\n[m]: https://example.com/map\n\nNext paragraph.\n'));
    expect(d.querySelector('a')?.getAttribute('href')).toBe('https://example.com/map');
    expect([...d.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['See the map here.', 'Next paragraph.']);
  });

  it('returns the same HTML for the same body', () => {
    const body = 'cached **body**\n';
    expect(renderNotePreviewHtml(body)).toBe(renderNotePreviewHtml(body));
  });
});
