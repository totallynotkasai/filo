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
 *  - mixed-prose:       a two-line blockquote is joined onto one line.
 *  - link-schemes:      `[[wiki]]` brackets are escaped. (Audit-19 UX-2 — the
 *                       `filo://` link marks now SURVIVE via Link's isAllowedUri.)
 *  - misc-syntax:       HTML comment / block `<div>` dropped, callout joined.
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
  'mixed-prose',
  'link-schemes',
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
