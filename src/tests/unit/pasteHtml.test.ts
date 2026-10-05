import { describe, it, expect } from 'vitest';
import { cleanPastedHtml } from '../../renderer/lib/editor/pasteHtml';

/** The cleaned paste as a DOM, to read. */
function cleaned(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = cleanPastedHtml(html);
  return div;
}

function styleOf(html: string): string {
  return cleaned(html).querySelector('span')?.getAttribute('style') ?? '';
}

describe('cleanPastedHtml: text colour', () => {
  it('drops near-black, near-white and Word\'s windowtext', () => {
    for (const colour of ['#000000', '#202122', 'rgb(32, 33, 34)', 'black', '#ffffff', 'rgb(240, 240, 240)', 'windowtext']) {
      expect(styleOf(`<span style="color: ${colour}">x</span>`)).toBe('');
    }
  });

  it('keeps any other colour', () => {
    expect(styleOf('<span style="color: #c00000">x</span>')).toMatch(/color: (#c00000|rgb\(192, 0, 0\))/i);
    expect(styleOf('<span style="color: #666666">x</span>')).toMatch(/color: (#666666|rgb\(102, 102, 102\))/i);
  });
});

describe('cleanPastedHtml: fonts and sizes', () => {
  it('drops the font most of the paste is in, and keeps another', () => {
    const div = cleaned(
      '<p><span style="font-family: Arial, sans-serif">Most of the text is here</span> <span style="font-family: Georgia">aside</span></p>',
    );
    const [base, other] = [...div.querySelectorAll('span')];
    expect(base?.getAttribute('style')).toBeNull();
    expect(other?.getAttribute('style')).toMatch(/Georgia/);
  });

  it('drops a bare generic family, even where it isn\'t the main font', () => {
    const div = cleaned('<p><span style="font-family: Georgia">most of the text</span> <span style="font-family: sans-serif">b</span></p>');
    expect([...div.querySelectorAll('span')].map((s) => s.getAttribute('style'))).toEqual([null, null]);
  });

  it('drops point sizes and keeps pixel sizes', () => {
    expect(styleOf('<span style="font-size: 11pt">x</span>')).toBe('');
    expect(styleOf('<span style="font-size: 14.0pt">x</span>')).toBe('');
    expect(styleOf('<span style="font-size: 20px">x</span>')).toMatch(/^font-size: 20px;?$/);
  });

  it('leaves bold, italic and underline written as styles for the editor to read', () => {
    expect(styleOf('<span style="font-weight: 700; font-style: italic; text-decoration: underline; font-size: 11pt">x</span>')).toBe(
      'font-weight: 700; font-style: italic; text-decoration: underline;',
    );
  });
});

describe('cleanPastedHtml: highlights', () => {
  it('makes a span\'s background a highlight', () => {
    const div = cleaned('<span style="background-color: #ffff00">marked</span>');
    expect(div.querySelector('span')?.getAttribute('style')).toBeNull();
    expect(div.querySelector('span > mark')?.getAttribute('data-color')).toBe('#ffff00');
    expect(div.querySelector('mark')?.textContent).toBe('marked');
  });

  it('makes Word\'s highlight a highlight', () => {
    const div = cleaned("<span style='mso-highlight:yellow'>marked</span>");
    expect(div.querySelector('mark')?.getAttribute('data-color')).toBe('#ffff00');
  });

  it('leaves a transparent or white background alone', () => {
    expect(cleaned('<span style="background-color: transparent">x</span>').querySelector('mark')).toBeNull();
    expect(cleaned('<span style="background-color: #ffffff">x</span>').querySelector('mark')).toBeNull();
  });
});

describe('cleanPastedHtml: Word\'s lists', () => {
  const item = (level: number, marker: string, text: string): string =>
    `<p class=MsoListParagraph style='mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;

  it('makes bullet paragraphs a list, nested by level, the bullets taken out', () => {
    const div = cleaned(item(1, '·', 'One') + item(2, 'o', 'Sub') + item(1, '·', 'Two') + '<p class=MsoNormal>After</p>');
    expect(div.querySelectorAll(':scope > ul > li').length).toBe(2);
    expect(div.querySelector(':scope > ul > li > ul > li')?.textContent).toBe('Sub');
    expect(div.textContent).not.toContain('·');
    expect(div.querySelector(':scope > p')?.textContent).toBe('After');
  });

  it('makes numbered paragraphs a numbered list', () => {
    const div = cleaned(item(1, '1.', 'First') + item(1, '2.', 'Second'));
    expect(div.querySelector(':scope > ol')?.children.length).toBe(2);
  });

  it('starts a new list where the same level switches between bullets and numbers', () => {
    const div = cleaned(item(1, '·', 'Bullet') + item(1, '1.', 'Number'));
    expect([...div.children].map((c) => c.tagName)).toEqual(['UL', 'OL']);
  });
});

describe('cleanPastedHtml: a copy from a Filo note', () => {
  it('is pasted as it is', () => {
    const html = '<p data-pm-slice="1 1 []"><span style="color: #000000; font-size: 11pt">x</span></p>';
    expect(cleanPastedHtml(html)).toBe(html);
  });
});
