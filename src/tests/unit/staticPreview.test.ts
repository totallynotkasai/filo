import { describe, it, expect } from 'vitest';
import { renderNotePreviewHtml } from '@renderer/lib/editor/staticPreview';

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

  it('keeps no newlines between blocks and joins a soft break with a space', () => {
    const html = renderNotePreviewHtml('first line\nsecond line\n\n- a\n- b\n');
    expect(html).not.toContain('\n');
    expect(dom(html).querySelector('p')?.textContent).toBe('first line second line');
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

  it('sanitises: no scripts, handlers, images or javascript: links', () => {
    const html = renderNotePreviewHtml(
      'text <script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[x](javascript:alert(3)) <b onclick="alert(4)">b</b>\n',
    );
    expect(html).not.toMatch(/<script|onerror|onclick|<img|href="javascript:/i);
    expect(dom(html).querySelector('b')?.textContent).toBe('b');
  });

  it('returns the same HTML for the same body', () => {
    const body = 'cached **body**\n';
    expect(renderNotePreviewHtml(body)).toBe(renderNotePreviewHtml(body));
  });
});
