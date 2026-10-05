import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Editor } from '@tiptap/core';
import { undoDepth, closeHistory } from '@tiptap/pm/history';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import {
  editorMarkdown,
  isLossyMarkdownRoundTrip,
  loadMarkdownIntoEditor,
  parseMarkdownFile,
} from '../../renderer/lib/editor/markdownSync';

/**
 * Golden-corpus BODY round-trip — the safety net for editor-library upgrades
 * (TipTap 2 → 3, tiptap-markdown 0.8 → 0.9). `ci:frontmatter-invariant` pins
 * frontmatter bytes; nothing else pinned the BODY bytes the real editor emits
 * after a load → serialise cycle with no user edit. A library upgrade that
 * shifts that output (TipTap 3's TrailingNode appending an empty paragraph,
 * TextStyle merging nested spans, a serializer tweak) silently rewrites every
 * affected file on its next save.
 *
 * Each `fixtures/markdown-body-roundtrip/<name>.md` is loaded through the REAL
 * editor factory + `loadMarkdownIntoEditor` (the production load path, incl.
 * empty-paragraph reconstruction) and serialised with `editorMarkdown` (the
 * production save path). The output must equal the fixture body byte-for-byte,
 * OR — where the editor already normalised the body on TipTap 2 — the recorded
 * TipTap 2 output in `<name>.expected.md`. The goal is NOT that every body is
 * untouched (tiptap-markdown has always normalised some syntax), it is that an
 * upgrade produces EXACTLY what the previous version produced.
 *
 * CRLF: `.gitattributes` forces LF on checkout, so every fixture is ALSO run
 * with its body converted to CRLF (the editor emits LF; the expected output is
 * the same LF bytes as the LF run, or `<name>.expected-crlf.md` if recorded).
 *
 * Pinned by `ci:markdown-body-roundtrip` (the gate fails if this file or the
 * fixture corpus goes missing / shrinks).
 */

const FIXTURE_DIR = join(process.cwd(), 'src/tests/unit/fixtures/markdown-body-roundtrip');

interface Fixture {
  name: string;
  body: string;
  expected: string;
  expectedCrlf: string;
}

function loadCorpus(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md') && !f.includes('.expected'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.md'.length);
      const raw = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      const body = parseMarkdownFile(raw).body;
      const expPath = join(FIXTURE_DIR, `${name}.expected.md`);
      const expCrlfPath = join(FIXTURE_DIR, `${name}.expected-crlf.md`);
      const expected = existsSync(expPath) ? readFileSync(expPath, 'utf8') : body;
      const expectedCrlf = existsSync(expCrlfPath) ? readFileSync(expCrlfPath, 'utf8') : expected;
      return { name, body, expected, expectedCrlf };
    });
}

const corpus = loadCorpus();

/**
 * Fixtures whose on-disk form the editor could NOT reproduce on TipTap 2, so
 * `loadMarkdownIntoEditor` flags them lossy and the document opens READ-ONLY
 * (no write can clobber the syntax). Recorded as the v2 baseline so an upgrade
 * can neither start locking editable files nor silently unlock one it would
 * rewrite. Every other fixture must stay editable (not lossy).
 *  - inline-html-spans: nested `<span style>` collapses to the inner span.
 *  - links-underline:   `<u>…[link](…)</u>` re-nests. (Audit-19 DEP-2 — with
 *                       linkify off the bare URL is now emitted verbatim, no
 *                       `<…>` wrap; the fixture stays lossy for the `<u>` only.)
 *  - misc-syntax:       HTML comment / block `<div>` dropped.
 * `link-schemes` LEFT this set when a line the file holds became written as
 * the file spells it (`minimalEscapes.ts`): its `[[wiki]]` brackets are no
 * longer escaped, so its baseline is the fixture bar the final newline;
 * misc-syntax's callout keeps its `[!note]` the same way.
 * `mixed-prose` LEFT this set when a single newline became a soft break node
 * (`softBreak.ts`): its two-line blockquote keeps its lines, and nothing else
 * in it changes; its baseline records the lines kept.
 * Audit-19 UX-7 — `task-lists` LEFT this set: a tight task list now serialises
 * tight (FiloTaskListTight), byte-identical to its source bar the final newline.
 *
 * TipTap 3 difference (the ONE place v3 output ≠ v2 output, deliberately
 * accepted): `relative-links` — TipTap 2's Link dropped the mark on a relative
 * `[note](Notes/Other.md)` (so that file opened read-only); TipTap 3's Link
 * keeps it, so the body now round-trips byte-identically and opens editable.
 * Its baseline is the fixture itself (no `.expected.md`).
 */
const LOSSY_ON_TIPTAP2: ReadonlySet<string> = new Set([
  'inline-html-spans',
  'links-underline',
  'misc-syntax',
]);
const editors: Editor[] = [];

function makeEditor(onUpdate?: () => void): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '', onUpdate });
  editors.push(ed);
  return ed;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function roundTrip(body: string): { out: string; lossy: boolean } {
  const ed = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(ed, body);
  return { out: editorMarkdown(ed), lossy };
}

const toCrlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

describe('markdown body round-trip — golden corpus', () => {
  it('corpus is present and non-trivial', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
  });

  for (const fx of corpus) {
    it(`${fx.name}: load → serialise is byte-identical to the baseline (LF)`, () => {
      expect(roundTrip(fx.body).out).toBe(fx.expected);
    });

    it(`${fx.name}: load → serialise is byte-identical to the baseline (CRLF)`, () => {
      expect(roundTrip(toCrlf(fx.body)).out).toBe(fx.expectedCrlf);
    });

    it(`${fx.name}: the serialised output is a fixed point (second cycle stable)`, () => {
      const first = roundTrip(fx.body).out;
      expect(roundTrip(first).out).toBe(first);
    });

    const lossyOnV2 = LOSSY_ON_TIPTAP2.has(fx.name);
    it(`${fx.name}: isLossyMarkdownRoundTrip verdict matches the TipTap 2 baseline (${lossyOnV2 ? 'read-only' : 'editable'})`, () => {
      const lf = roundTrip(fx.body);
      expect(lf.lossy).toBe(lossyOnV2);
      expect(isLossyMarkdownRoundTrip(fx.body, lf.out)).toBe(lossyOnV2);
      expect(roundTrip(toCrlf(fx.body)).lossy).toBe(lossyOnV2);
    });

    it(`${fx.name}: the editor's own canonical output is never flagged lossy`, () => {
      // A file Filo itself wrote must reopen editable — otherwise every save
      // would lock the document read-only on the next open.
      expect(roundTrip(fx.expected).lossy).toBe(false);
    });

    it(`${fx.name}: loading into the real editor emits no update`, () => {
      let updates = 0;
      const ed = makeEditor(() => {
        updates++;
      });
      loadMarkdownIntoEditor(ed, fx.body);
      loadMarkdownIntoEditor(ed, toCrlf(fx.body), { preserveSelection: true });
      expect(updates).toBe(0);
    });

    // Audit-19 MD-1 — a load is not an undoable edit. Pre-fix, Ctrl+Z right
    // after opening a note emptied it ("\n", 1 update) and autosave wrote that.
    it(`${fx.name}: load → undo is a no-op`, () => {
      let updates = 0;
      const ed = makeEditor(() => {
        updates++;
      });
      loadMarkdownIntoEditor(ed, fx.body);
      const before = editorMarkdown(ed);
      expect(ed.commands.undo()).toBe(false);
      expect(editorMarkdown(ed)).toBe(before);
      expect(updates).toBe(0);
      expect(undoDepth(ed.state)).toBe(0);
    });

    it(`${fx.name}: reload → undo cannot cross the reload`, () => {
      let updates = 0;
      const ed = makeEditor(() => {
        updates++;
      });
      loadMarkdownIntoEditor(ed, 'Body A\n');
      ed.commands.focus('end');
      ed.commands.insertContent('!');
      ed.view.dispatch(closeHistory(ed.state.tr));
      updates = 0;
      loadMarkdownIntoEditor(ed, fx.body, { preserveSelection: true });
      // The reload is a history boundary: the pre-reload `!` must not survive
      // (with `addToHistory:false` alone it lingers as a remapped step).
      expect(undoDepth(ed.state)).toBe(0);
      const afterReload = editorMarkdown(ed);
      ed.commands.undo();
      expect(editorMarkdown(ed)).toBe(afterReload);
      expect(updates).toBe(0);
    });
  }

  // Audit-19 DEP-2 — Link's default shouldAutoLink accepted any dotted hostname.
  it('typing a filename does not autolink', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Start\n');
    ed.commands.focus('end');
    ed.commands.insertContent(' see Notes.md ');
    expect(editorMarkdown(ed)).not.toContain('](http');
  });

  it('typing an explicit https URL still autolinks', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Start\n');
    ed.commands.focus('end');
    ed.commands.insertContent(' https://example.com ');
    expect(editorMarkdown(ed)).toContain('https://example.com');
    expect(ed.getHTML()).toContain('href="https://example.com"');
  });

  // Audit-19 UX-7 — checklists Filo creates are tight (no blank lines).
  it('a new checklist created in the editor serialises tight', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'milk\n');
    ed.commands.focus('end');
    ed.commands.toggleTaskList();
    ed.commands.splitListItem('taskItem');
    ed.commands.insertContent('eggs');
    expect(editorMarkdown(ed)).toBe('- [ ] milk\n- [ ] eggs');
  });

  it('positive control: typing after a load is still undoable', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Hello\n');
    ed.commands.focus('end');
    ed.commands.insertContent('X');
    expect(editorMarkdown(ed)).toContain('HelloX');
    expect(ed.commands.undo()).toBe(true);
    expect(editorMarkdown(ed)).not.toContain('HelloX');
  });
});

/**
 * Shapes Filo writes that it used to read back differently (so the note
 * reopened read-only): the checklist, list, leading-space, table and code
 * fence cases, and every counter-example the round-trip property test
 * (`editorRoundTripProperty.test.ts`) found while they were fixed. Each must
 * load editable and save to the same bytes.
 */
const FILO_WRITES: ReadonlyArray<[string, string]> = [
  ['Enter after the last task', '- [ ] a\n- [ ] '],
  ['an empty task after a paragraph', 'x\n\n- [ ] '],
  ['an empty checked task holding sub-tasks', '- [x] \n  - [ ] \n  - [ ] z'],
  ['a checklist item between two bullet lists', '- a\n\n* [ ] b\n\n- c'],
  ['two bullet lists with an empty line between', '- a\n\n\n* b'],
  ['Enter twice in a numbered list', '1. a\n2. b\n\n\n1) c'],
  ['a numbered list typed from 0', '0. zero\n1. one'],
  ['two adjacent bullet lists', '- a\n- b\n\n* c'],
  ['a nested list item holding a rule, under a tight list', '- a\n  - b\n\n    ---\n- c'],
  ['an empty line after a list', '- a\n\n\n# b'],
  ['an empty first item of a nested list', '- a\n  - &#32;\n  - b'],
  ['a paragraph typed with one leading space', '&#32;one'],
  ['a paragraph typed with four leading spaces', '&#32;   four'],
  ['a leading space after a line break', 'a\\\n&#32; b'],
  ['a list item typed with leading spaces', '- &#32;  text'],
  ['a bold run after leading spaces', '&#32;**bold**'],
  ['a pipe in a table cell', '| one yes\\|no | two |\n| --- | --- |\n| a | b |\n'],
  ['a pipe in inline code in a table cell', '| `a\\|b` |\n| --- |\n| c |\n'],
  ['an aligned table', '| a | b | c |\n| :--- | :---: | ---: |\n| d | e | f |\n'],
  ['code holding a line of three backticks', '````\na\n```\nb\n````'],
  ['code holding a line of four backticks', '`````md\n````\n`````'],
  ['a line break in a heading', '# Title<br>next'],
  ['a heading ending in " #"', '# a \\#'],
  ['a heading that is only "#"', '# \\#'],
  ['a lone "+"', '\\+'],
  ['a lone "1."', '1\\.'],
  ['"- " after a line break', 'a\\\n\\- b'],
  ['"-" and a tab after a line break', '1. \\\n   \\-\ta'],
  ['a row of "=" after a line break', 'a\\\n\\==='],
  ['a bold run after a line break in a quote', '> a\\\n> **b** c'],
  ['a bold run opening a second paragraph in a quote', '> &#9;\n>\n> **a** b'],
  ['a quote whose first line was empty', '> a'],
  ['an escaped backslash before "!" and a link', '\\\\\\![a](https://example.com/a)'],
  ['"1." on a line before a soft break', '1\\.\nbeta'],
  ['a row of "=" before a soft break', 'a\\\n\\==\nb'],
  ['bold ending in punctuation right before a letter', '<strong>A)</strong>Answer'],
  ['italic on one comma between letters', 'a<em>,</em>b'],
  ['bold, then italic straight after it', '<strong>Name:</strong>*Aria*'],
  ['bold throughout, italic on its first and last letters', '***A*b<em>c</em>**'],
  ['"01." after a line break', 'Chapters:\\\n01\\. Arrival'],
  ['"1." after a soft break inside underlining', '<u>a\n1\\. one</u>'],
  ['a numbered sub-list starting at 3 under its item\'s text', '- parent\n\n  3. child'],
  ['a loose sub-list in a tight list', '- a\n  - b\n\n    3. c\n\n  - d'],
  ['a sub-list under an item with no text, in a loose list', '- a\n\n  3. b\n\n- \n  - c'],
  ['two bullet lists side by side', '- a\n\n* b'],
  ['an autolink holding "*" and "~"', '<https://x.com/a*b_c~d>'],
  ['a link whose text is its percent-encoded address', '[https://example.com/My%20File.pdf](https://example.com/My%20File.pdf)'],
  // The spaces around a link inside an italic or bold phrase stay inside the
  // phrase (the writer keeps the emphasis open around the link).
  ['an italic phrase holding links', '*Thanks to [Titus Wormer](https://github.com/wooorm) for [encouraging me](https://example.com/1) to do this.*'],
  ['a bold phrase holding a link', '**See [the map](https://example.com/map) first.**'],
  // A no-break space where Markdown trims whitespace other than spaces.
  ['a no-break space opening a table cell', '| &#160;a |\n| --- |\n| b |\n'],
  ['a no-break space closing a table cell', '| a&#160; |\n| --- |\n| b |\n'],
  ['a table cell holding only a no-break space', '| &#160; |\n| --- |\n| b |\n'],
  ['a no-break space after the break a list item opens with', '- <br data-filo-soft-break>&#160;\n  - a'],
  ['a no-break space alone on a paragraph\'s last line', 'a\n \n\nz'],
];

describe('shapes Filo writes read back as written', () => {
  for (const [name, body] of FILO_WRITES) {
    it(name, () => {
      const rt = roundTrip(body);
      expect(rt.lossy).toBe(false);
      expect(rt.out).toBe(body);
    });
  }
});

/**
 * The shapes of the owner's real notes (Keep and Canvas exports, plain
 * typing): one line per thought with no blank line between, and literal
 * asterisks and underscores Markdown doesn't read as emphasis. Each loads
 * editable and saves byte for byte.
 */
const OTHER_APPS: ReadonlyArray<[string, string]> = [
  ['a list of titles on consecutive lines', 'Potential Titles:\nDilletantes in the Interim\nProspectors in the Interim\n\nCover Ideas:\nSolo portraits - a stump\nGroup portraits - a river bank.'],
  ['a bold heading line followed by text', '**Circus**\nShikara could hear the guards talking.\n\n**Alternate Start**\nKasai is also another person.'],
  ['a bold line, then a list of stats on consecutive lines', '**Potential stats**\nPhysical (likely capped)\nStrength — raw power\nEndurance — stamina'],
  ['"2** - " after a word', 'Chapter 1 and 2** - To be kept the same.\n\n**Chapter 3** - Needs a rework.'],
  ['"-** " closing nothing, then a bold run', 'Chapter 7 -** I think it can stay, although **chapter 6** could change.'],
  ['a "***" placeholder in running text', "she's from the *** and hes from *** they're surprised"],
  ['a "___" placeholder in running text', "she's from the ___ and hes from ___ they're surprised"],
  ['a two-line quote', '> A quote\n> over two lines.'],
  ['lines in a list item', '- first line\n  second line\n- next'],
  ['a bold run over a soft break', '**bold over\ntwo lines** then text'],
  ['escapes the file already has', 'Escaped \\*stars\\* and a literal 5 \\* 3.'],
];

describe('notes from other apps keep their single newlines and literal asterisks', () => {
  for (const [name, body] of OTHER_APPS) {
    it(name, () => {
      const rt = roundTrip(body);
      expect(rt.lossy).toBe(false);
      expect(rt.out).toBe(body);
    });
  }

  it('a soft break loads as its own node and shows as a line break', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'one\ntwo');
    expect(ed.getJSON().content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'softBreak', 'text']);
    expect(ed.getHTML()).toBe('<p>one<br data-filo-soft-break="">two</p>');
  });

  it('typing on the line after a soft break keeps the lines apart', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Potential Titles:\nDilletantes in the Interim');
    ed.commands.focus('end');
    ed.commands.insertContent(' (working)');
    expect(editorMarkdown(ed)).toBe('Potential Titles:\nDilletantes in the Interim (working)');
  });

  it('Shift+Enter still writes a hard break', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'one\ntwo');
    ed.commands.focus('end');
    ed.commands.setHardBreak();
    ed.commands.insertContent('three');
    expect(editorMarkdown(ed)).toBe('one\ntwo\\\nthree');
  });

  it('deleting the text before a soft break keeps the break as a node that reads back', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'one\ntwo');
    ed.commands.deleteRange({ from: 1, to: 4 });
    const md = editorMarkdown(ed);
    expect(md).toBe('<br data-filo-soft-break>two');
    const rt = roundTrip(md);
    expect(rt.lossy).toBe(false);
    expect(rt.out).toBe(md);
  });

  it('asterisks typed as text are written bare where Markdown reads them as text', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Start');
    ed.commands.focus('end');
    ed.commands.insertContent({ type: 'text', text: ' the *** and 2** - end' });
    expect(editorMarkdown(ed)).toBe('Start the *** and 2** - end');
  });

  it('asterisks that would pair as emphasis stay escaped', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Start');
    ed.commands.focus('end');
    ed.commands.insertContent({ type: 'text', text: ' *not italic*' });
    const md = editorMarkdown(ed);
    // One escape is enough: the closing `*` can't close without an opener.
    expect(md).toBe('Start *not italic\\*');
    const reread = makeEditor();
    loadMarkdownIntoEditor(reread, md);
    expect(reread.getText()).toBe('Start *not italic*');
    const rt = roundTrip(md);
    expect(rt.lossy).toBe(false);
    expect(rt.out).toBe(md);
  });

  it('a typed "___" reads back as underscores, not emphasis', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Start');
    ed.commands.focus('end');
    ed.commands.insertContent({ type: 'text', text: ' from the ___ and from ___ they' });
    const md = editorMarkdown(ed);
    const reread = makeEditor();
    loadMarkdownIntoEditor(reread, md);
    expect(reread.getText()).toBe('Start from the ___ and from ___ they');
  });
});

describe('Markdown from other apps', () => {
  it('a `~~~` fence opens editable; Filo fences it with backticks', () => {
    const rt = roundTrip('~~~js\nx\n~~~');
    expect(rt.lossy).toBe(false);
    expect(rt.out).toBe('```js\nx\n```');
  });

  it('a mixed bullet / checklist list loads without a filler checkbox, and stays read-only', () => {
    const ed = makeEditor();
    const { lossy } = loadMarkdownIntoEditor(ed, '- a\n- [ ] b');
    expect(lossy).toBe(true);
    expect(ed.getJSON().content?.map((n) => n.type)).toEqual(['bulletList', 'taskList']);
    expect(editorMarkdown(ed)).toBe('- a\n\n* [ ] b');
  });

  it('a `:--` alignment row is written as `:---`, which the check treats as the same', () => {
    const rt = roundTrip('| a |\n| :-- |\n| b |');
    expect(rt.lossy).toBe(false);
    expect(rt.out).toBe('| a |\n| :--- |\n| b |\n');
  });
});

describe('tables Markdown cannot hold are written as HTML', () => {
  function tableDoc(cell: object): object {
    const p = (text: string): object => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    return {
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Head')] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [cell] }] },
        ],
      }],
    };
  }

  it.each([
    ['a list in a cell', { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] }],
    ['a heading in a cell', { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Big' }] }],
  ])('%s', (_name, cell) => {
    const ed = makeEditor();
    ed.commands.setContent(tableDoc(cell));
    const md = editorMarkdown(ed);
    expect(md).toMatch(/^<table[ >]/);
    const rt = roundTrip(md);
    expect(rt.lossy).toBe(false);
    expect(rt.out).toBe(md);
  });
});
