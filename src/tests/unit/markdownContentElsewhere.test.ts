import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Editor, JSONContent } from '@tiptap/core';
import { micromark } from 'micromark';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import {
  editorMarkdown,
  loadMarkdownIntoEditor,
  markdownRenderer,
  parseMarkdownFile,
} from '../../renderer/lib/editor/markdownSync';
import { TOOLBAR_CASES, applyToolbarCase } from '../helpers/toolbarCases';

/**
 * A note Filo writes says the same thing in other Markdown apps.
 *
 * Each input is a note as Filo saves it: every golden-corpus fixture in the
 * form a save writes it (`<name>.expected.md`, else the fixture's body), and
 * every toolbar case's saved note. It is rendered twice:
 * - by the note's own markdown-it, the instance the read-only check reads it
 *   with (`markdownRenderer`);
 * - by micromark, a strict CommonMark parser, with GitHub's table,
 *   strikethrough and task-list extensions.
 *
 * Both must show the same words, the same ticked and unticked boxes, and the
 * same link and image addresses. For a fixture that opens editable, micromark
 * must also show the same before and after the save: saving changes nothing
 * another app shows.
 *
 * micromark is a test oracle only, as js-yaml is for YAML: the app has one
 * Markdown parser (gate `one-markdown-parser`). Its all-in-one GFM extension
 * isn't used, because it turns bare addresses into links and moves footnotes
 * to the end, which markdown-it as Filo sets it up doesn't do: words would
 * move for reasons that have nothing to do with what Filo writes. So this
 * check can't see what GitHub's linking of bare addresses does to an escape
 * inside one (BL-17).
 *
 * Where `*` and `~~` interleave, the parsers disagree in more than one way.
 * micromark pairs emphasis and strikethrough in separate passes, so it can
 * read a note differently from both markdown-it and GitHub (`*~~*a~~*`,
 * italic and struck over `*a`); and GitHub can differ from both (BL-18), which
 * this check can't see. Check such a difference against GitHub before
 * treating it as Filo's.
 *
 * A difference is a finding: fix the writer, or pin it under "known
 * differences" with its reason.
 */

const FIXTURE_DIR = join(process.cwd(), 'src/tests/unit/fixtures/markdown-body-roundtrip');

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

/**
 * micromark with GitHub's table, strikethrough and task lists. Raw HTML is
 * kept, as markdown-it keeps it for Filo (`html: true`); so is every link
 * address, so `filo://` links compare by their address instead of micromark
 * blanking them.
 */
function micromarkHtml(markdown: string): string {
  return micromark(markdown, {
    allowDangerousHtml: true,
    allowDangerousProtocol: true,
    extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem()],
    htmlExtensions: [gfmTableHtml(), gfmStrikethroughHtml(), gfmTaskListItemHtml()],
  });
}

/** The note's markdown-it, after a load has registered every extension's Markdown setup on it. */
function markdownItHtml(ed: Editor, markdown: string): string {
  loadMarkdownIntoEditor(ed, markdown);
  const md = markdownRenderer(ed);
  if (!md) throw new Error('the editor has no markdown-it');
  return md.render(markdown);
}

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, ul, ol, blockquote, pre, table, thead, tbody, tr, th, td, hr, div';

interface Shown {
  /** The visible text, a box as `[x]` / `[ ]`, every run of white space as one space. */
  text: string;
  /** Link and image addresses, in order. */
  addresses: string[];
}

/**
 * What a reader sees in the rendered HTML. Where blocks meet, and at a line
 * break, words are apart on screen whether or not the HTML has white space
 * there (the two renders don't put the same white space between blocks), so
 * each counts as a space.
 */
function shown(html: string): Shown {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const br of [...doc.querySelectorAll('br')]) br.replaceWith(doc.createTextNode(' '));
  for (const box of [...doc.querySelectorAll('input[type="checkbox"]')]) {
    box.replaceWith(doc.createTextNode(box.hasAttribute('checked') ? ' [x] ' : ' [ ] '));
  }
  for (const block of [...doc.querySelectorAll(BLOCKS)]) {
    block.before(doc.createTextNode(' '));
    block.after(doc.createTextNode(' '));
  }
  const addresses = [...doc.querySelectorAll('a[href], img[src]')].map((el) => el.getAttribute('href') ?? el.getAttribute('src') ?? '');
  return { text: (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim(), addresses };
}

interface Input {
  name: string;
  /** The note as Filo saves it. */
  saved: string;
  /** A fixture's body as it is in the file, when the fixture opens editable. */
  editableSource?: string;
}

function fixtureInputs(): Input[] {
  const ed = makeEditor();
  const inputs = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md') && !f.includes('.expected'))
    .sort()
    .map((file): Input => {
      const name = file.slice(0, -'.md'.length);
      const body = parseMarkdownFile(readFileSync(join(FIXTURE_DIR, file), 'utf8')).body;
      const expected = join(FIXTURE_DIR, `${name}.expected.md`);
      const saved = existsSync(expected) ? readFileSync(expected, 'utf8') : body;
      const { lossy } = loadMarkdownIntoEditor(ed, body);
      return { name: `fixture ${name}`, saved, editableSource: lossy ? undefined : body };
    });
  editors.pop()!.destroy();
  return inputs;
}

function toolbarInputs(): Input[] {
  return TOOLBAR_CASES.map((c): Input => {
    const ed = makeEditor();
    const saved = applyToolbarCase(ed, c);
    editors.pop()!.destroy();
    return { name: `toolbar case "${c.name}"`, saved };
  });
}

const fixtures = fixtureInputs();
const toolbar = toolbarInputs();

describe('a note Filo writes reads the same in another Markdown parser', () => {
  it('reads every golden fixture and every toolbar case', () => {
    const sources = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md') && !f.includes('.expected'));
    expect(fixtures).toHaveLength(sources.length);
    expect(fixtures.length).toBeGreaterThan(0);
    expect(toolbar).toHaveLength(TOOLBAR_CASES.length);
    expect(fixtures.filter((f) => f.editableSource !== undefined).length).toBeGreaterThan(0);
  });

  for (const input of [...fixtures, ...toolbar]) {
    it(input.name, () => {
      const ed = makeEditor();
      expect(shown(micromarkHtml(input.saved))).toEqual(shown(markdownItHtml(ed, input.saved)));
    });
  }
});

describe('saving a note that opens editable changes nothing another app shows', () => {
  for (const input of fixtures.filter((f) => f.editableSource !== undefined)) {
    it(input.name, () => {
      expect(shown(micromarkHtml(input.saved))).toEqual(shown(micromarkHtml(input.editableSource!)));
    });
  }
});

/**
 * Notes typed in Filo that it saves in a form GitHub reads differently (both
 * checked against GitHub's own renderer, as micromark reads them). Each case
 * pins what Filo saves and what each parser shows; when the writer is fixed,
 * the case fails and should move up into the inputs above. They are also the
 * proof that the comparison can fail.
 */
describe('known differences', () => {
  function typed(content: JSONContent[]): string {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.insertContent({ type: 'paragraph', content });
    return editorMarkdown(ed);
  }

  // BL-15: markdown-it strikes text through only between `~~`; GitHub also
  // takes a single `~` each side. Typed tildes are saved as typed, so GitHub
  // strikes "one" through.
  it('a pair of single tildes typed as text', () => {
    const saved = typed([{ type: 'text', text: 'a ~one~ b' }]);
    expect(saved).toBe('a ~one~ b');
    expect(shown(markdownItHtml(makeEditor(), saved)).text).toBe('a ~one~ b');
    expect(shown(micromarkHtml(saved)).text).toBe('a one b');
  });

  // BL-16: a `~` typed right before struck text is saved bare, next to the
  // `~~` that opens the strikethrough. markdown-it takes the last two of the
  // three tildes as the opener; GitHub reads a run of three as text, so it
  // shows every tilde and strikes nothing. (A `~` inside the struck text is
  // escaped, `~~\~a~~`, and reads the same in both.)
  it('a tilde typed right before struck text', () => {
    const saved = typed([
      { type: 'text', text: 'x ~' },
      { type: 'text', text: 'a', marks: [{ type: 'strike' }] },
      { type: 'text', text: ' y' },
    ]);
    expect(saved).toBe('x ~~~a~~ y');
    expect(shown(markdownItHtml(makeEditor(), saved)).text).toBe('x ~a y');
    expect(shown(micromarkHtml(saved)).text).toBe('x ~~~a~~ y');
  });
});
