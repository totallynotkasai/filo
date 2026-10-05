import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Rich text pasted from Google Docs, Word and a web page, through the real
 * paste in Chromium, then saved and reopened. The source's own text colour,
 * font and point sizes are dropped (Docs pasted black Arial 11 pt on every
 * run: unreadable in a dark theme, smaller than the note), its highlights
 * kept, and Word's bullets become a real list instead of a `·` glued to the
 * line, which opened the note read-only.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

/** Pastes `html` on a new line after "Start.", saves, and checks the save reopens editable as the same bytes. */
function pasteAndSave(html: string): { ed: Editor; disk: string } {
  const ed = makeEditor();
  loadMarkdownIntoEditor(ed, 'Start.');
  ed.commands.focus('end');
  ed.commands.splitBlock();
  ed.view.pasteHTML(html);
  const disk = editorMarkdown(ed);
  const reopened = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(reopened, disk);
  expect({ disk, lossy }).toEqual({ disk, lossy: false });
  expect(editorMarkdown(reopened)).toBe(disk);
  return { ed, disk };
}

/** The marks on the text run holding `text`. */
function marksOn(ed: Editor, text: string): Record<string, unknown> {
  let found: ProseMirrorNode | null = null;
  ed.state.doc.descendants((node) => {
    if (!found && node.isText && node.text?.includes(text)) found = node;
    return !found;
  });
  const node = found as ProseMirrorNode | null;
  if (!node) throw new Error(`no "${text}" in the note`);
  return Object.fromEntries(node.marks.map((m) => [m.type.name, m.attrs]));
}

const GOOGLE_DOCS =
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
  '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;text-decoration:none;white-space:pre-wrap;">“I don’t know,” she said. </span>' +
  '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;font-style:italic;text-decoration:none;white-space:pre-wrap;">Never again.</span></p>' +
  '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:#ffff00;font-weight:400;text-decoration:underline;white-space:pre-wrap;">Highlighted and underlined.</span>' +
  '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#1155cc;white-space:pre-wrap;"> Blue words.</span></p></b>';

const WORD =
  "<html xmlns:o=\"urn:schemas-microsoft-com:office:office\"><body lang=EN-GB style='tab-interval:36.0pt'><!--StartFragment-->" +
  "<p class=MsoListParagraphCxSpFirst style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-fareast-font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US style='font-family:\"Times New Roman\",serif'>First point<o:p></o:p></span></p>" +
  "<p class=MsoListParagraphCxSpMiddle style='margin-left:72.0pt;text-indent:-18.0pt;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='font-family:\"Courier New\"'><span style='mso-list:Ignore'>o<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US style='font-family:\"Times New Roman\",serif'>A detail<o:p></o:p></span></p>" +
  "<p class=MsoListParagraphCxSpLast style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US style='font-family:\"Times New Roman\",serif'>Second point<o:p></o:p></span></p>" +
  "<p class=MsoNormal><b><span lang=EN-US style='font-size:14.0pt;line-height:107%;font-family:\"Times New Roman\",serif;color:#C00000'>Chapter One</span></b><span lang=EN-US style='font-size:12.0pt;font-family:\"Times New Roman\",serif'><o:p></o:p></span></p>" +
  "<p class=MsoNormal style='text-align:center'><i><span lang=EN-US style='font-size:12.0pt;font-family:\"Times New Roman\",serif;color:windowtext;mso-highlight:yellow'>Centred italic.</span></i></p>" +
  '<!--EndFragment--></body></html>';

const WORD_NUMBERED =
  "<p class=MsoListParagraphCxSpFirst style='mso-list:l1 level1 lfo2'><![if !supportLists]><span><span style='mso-list:Ignore'>1.<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp; </span></span></span><![endif]>Arrive<o:p></o:p></p>" +
  "<p class=MsoListParagraphCxSpLast style='mso-list:l1 level1 lfo2'><![if !supportLists]><span><span style='mso-list:Ignore'>2.<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp; </span></span></span><![endif]>Leave<o:p></o:p></p>";

const WEB =
  '<p>The <b>Dragon</b> (<a href="https://en.wikipedia.org/wiki/Dragon">from Greek</a>) is a ' +
  '<span style="color: rgb(32, 33, 34); font-family: sans-serif; font-size: 14px;">legendary creature</span> ' +
  '<span style="color: rgb(200, 30, 30); font-family: Georgia;">of myth</span>.</p><ul><li>One</li><li>Two</li></ul>';

describe('a Google Docs paste', () => {
  it('drops the black Arial 11 pt every run carries, and keeps bold, italic, underline, colour and highlight', () => {
    const { ed, disk } = pasteAndSave(GOOGLE_DOCS);
    expect(disk).not.toMatch(/Arial|11pt|#000000|rgb\(0, 0, 0\)/);
    expect(Object.keys(marksOn(ed, 'Never again.')).sort()).toEqual(['bold', 'italic']);
    const highlighted = marksOn(ed, 'Highlighted and underlined.');
    expect(highlighted.highlight).toEqual({ color: '#ffff00' });
    expect(highlighted.underline).toBeDefined();
    expect(marksOn(ed, 'Blue words.').textStyle).toMatchObject({ color: expect.stringMatching(/#1155cc|rgb\(17, 85, 204\)/i) });
    expect(marksOn(ed, 'I don’t know').textStyle).toBeUndefined();
  });
});

describe('a Word paste', () => {
  it('makes its bullets a real list, nested by level, with no bullet character left in the text', () => {
    const { ed, disk } = pasteAndSave(WORD);
    expect(disk).not.toContain('·');
    expect(disk).toContain('- First point\n  - A detail\n- Second point');
    expect(ed.getText()).not.toMatch(/^o\s/m);
  });

  it('drops its font and point sizes, and keeps a real colour, bold, italic, centring and highlight', () => {
    const { ed, disk } = pasteAndSave(WORD);
    expect(disk).not.toMatch(/Times New Roman|pt;|windowtext/);
    expect(marksOn(ed, 'Chapter One')).toMatchObject({ bold: {}, textStyle: { color: expect.stringMatching(/#c00000|rgb\(192, 0, 0\)/i) } });
    const centred = marksOn(ed, 'Centred italic.');
    expect(centred.italic).toBeDefined();
    expect(centred.highlight).toEqual({ color: '#ffff00' });
    expect(centred.textStyle).toBeUndefined();
    let align: unknown = null;
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Centred italic.') align = node.attrs.textAlign;
      return true;
    });
    expect(align).toBe('center');
  });

  it('makes numbered paragraphs a numbered list', () => {
    const { disk } = pasteAndSave(WORD_NUMBERED);
    expect(disk).toContain('1. Arrive\n2. Leave');
  });
});

describe('a web page paste', () => {
  it('drops near-black text and a generic font, and keeps a pixel size, another colour and font', () => {
    const { ed, disk } = pasteAndSave(WEB);
    expect(disk).not.toMatch(/rgb\(32, 33, 34\)|sans-serif/);
    const legendary = marksOn(ed, 'legendary creature').textStyle as Record<string, unknown> | undefined;
    expect(legendary?.fontSize).toBe('14px');
    expect(legendary?.color || null).toBeNull();
    expect(legendary?.fontFamily || null).toBeNull();
    expect(marksOn(ed, 'of myth').textStyle).toMatchObject({ fontFamily: expect.stringContaining('Georgia') });
    expect(disk).toContain('- One\n- Two');
  });
});

describe('a copy from a Filo note', () => {
  it('keeps every colour as the note had it, black included', () => {
    const source = makeEditor();
    loadMarkdownIntoEditor(source, 'A <span style="color: #000000;">black</span> word.');
    const html = source.view.dom.innerHTML;
    // ProseMirror marks the HTML it puts on the clipboard.
    const copied = `<p data-pm-slice="1 1 []">${html.replace(/^<p[^>]*>|<\/p>$/g, '')}</p>`;
    const { ed } = pasteAndSave(copied);
    expect(marksOn(ed, 'black').textStyle).toMatchObject({ color: expect.stringMatching(/#000000|rgb\(0, 0, 0\)/) });
  });
});
