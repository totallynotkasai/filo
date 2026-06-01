import { describe, it, expect } from 'vitest';
import type { Editor } from '@tiptap/core';
import {
  parseMarkdownFile,
  assembleMarkdownFile,
  loadMarkdownIntoEditor,
  isLossyMarkdownRoundTrip,
} from '../../renderer/lib/editor/markdownSync';

describe('markdownSync — parseMarkdownFile', () => {
  it('returns empty document for empty input', () => {
    const r = parseMarkdownFile('');
    expect(r).toEqual({ frontmatter: {}, rawFrontmatter: '', body: '', hasFrontmatter: false, hadBom: false });
  });

  it('parses body without frontmatter', () => {
    const r = parseMarkdownFile('# heading\n\nbody');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('# heading\n\nbody');
    expect(r.hasFrontmatter).toBe(false);
  });

  it('splits frontmatter and body', () => {
    const src = '---\ntitle: Foo\ntags: [a, b]\n---\n# heading\n\nbody';
    const r = parseMarkdownFile(src);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.frontmatter.tags).toEqual(['a', 'b']);
    expect(r.body).toBe('# heading\n\nbody');
  });

  it('handles malformed YAML by leaving frontmatter empty', () => {
    const src = '---\ntitle: : :\n---\nbody';
    const r = parseMarkdownFile(src);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.body).toBe('body');
  });

  it('preserves CRLF line endings in fenced delimiters', () => {
    const src = '---\r\ntitle: Foo\r\n---\r\nbody';
    const r = parseMarkdownFile(src);
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.body).toBe('body');
  });
});

// ── 6.4.M9 — fence trailing whitespace ───────────────────────────────────────
// Editors and linters routinely leave trailing horizontal whitespace on a fence
// line (`--- `). The fence regex required `---` IMMEDIATELY followed by a
// newline, so such a file parsed as "no frontmatter" — its YAML leaked into the
// body and (via tagRewriter) a duplicate `---` block was prepended on the next
// tag edit. Trailing spaces/tabs on either fence are now tolerated.
//
// 6.4.M10 was REFUTED (see parseMarkdownFile's comment): a `---` embedded in a
// multi-line scalar cannot mis-segment, because a column-0 `---` is a YAML
// document boundary that both YAML parsers reject, and a valid in-scalar `---`
// is indented and never matches the column-0 fence regex.
describe('markdownSync — parseMarkdownFile fence robustness (6.4.M9)', () => {
  it('M9 — tolerates trailing whitespace on the opening fence', () => {
    const r = parseMarkdownFile('--- \ntitle: Foo\n---\nbody');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.body).toBe('body');
  });

  it('M9 — tolerates trailing whitespace on the closing fence', () => {
    const r = parseMarkdownFile('---\ntitle: Foo\n--- \nbody');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.body).toBe('body');
  });

  it('M9 — tolerates a tab after the fence on a CRLF file', () => {
    const r = parseMarkdownFile('---\t\r\ntitle: Foo\r\n---\t\r\nbody');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.body).toBe('body');
  });

  it('M9 — does NOT treat `----` or `--- text` as a fence', () => {
    // Four dashes is a thematic break; trailing non-space text isn't a fence.
    expect(parseMarkdownFile('----\nnot fm\n----\nbody').hasFrontmatter).toBe(false);
    expect(parseMarkdownFile('--- text\nx\n---\nbody').hasFrontmatter).toBe(false);
  });

  it('preserves an indented `---` inside a block scalar (6.4.M10 refutation)', () => {
    // A column-0 `---` is a YAML document boundary (both parsers reject it), so a
    // VALID multi-line scalar containing `---` keeps it indented — which the
    // column-0 fence regex never matches. Confirms the first-fence split doesn't
    // truncate real block-scalar content (the scenario M10 feared).
    const src = '---\ntitle: Foo\nnote: |\n  before\n  ---\n  after\nstatus: ok\n---\nbody';
    const r = parseMarkdownFile(src);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.status).toBe('ok');
    expect(r.frontmatter.note).toBe('before\n---\nafter\n');
    expect(r.body).toBe('body');
  });
});

// ── Audit2 / 1.1 + 1.2 — frontmatter preservation ───────────────────────────
// 1.1 (amplifier): parseMarkdownFile flags `hasFrontmatter:true` but leaves
// `frontmatter:{}` on unparseable / non-object YAML; assembleMarkdownFile gated
// the fence only on `Object.keys(fm).length`, so a body-only re-assembly DROPPED
// the fence and erased the whole block. The raw source is now threaded out of
// parse and written back verbatim so a fence we couldn't parse is never lost.
// 1.2 (cure): a clean body-only save emits the original frontmatter bytes
// verbatim (comments / key order / line endings preserved) instead of re-dumping
// the parsed object. The object is re-serialised only when it actually changed.
describe('markdownSync — frontmatter preservation (Audit2 1.1/1.2)', () => {
  it('threads the raw frontmatter source out of parseMarkdownFile', () => {
    const r = parseMarkdownFile('---\ntitle: Foo\ntags: [a, b]\n---\nbody');
    expect(r.rawFrontmatter).toBe('title: Foo\ntags: [a, b]');
  });

  it('returns an empty rawFrontmatter when there is no frontmatter', () => {
    expect(parseMarkdownFile('# just a body').rawFrontmatter).toBe('');
    expect(parseMarkdownFile('').rawFrontmatter).toBe('');
  });

  it('1.1 — preserves an unparseable (tab-indented) frontmatter block on body re-assembly', () => {
    const src = ['---', 'title: Keep me', '\tbad: indentation', '---', 'old body'].join('\n');
    const parsed = parseMarkdownFile(src);
    // The parser can't build an object from this YAML…
    expect(parsed.hasFrontmatter).toBe(true);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
    // …but the raw block must survive a body-only save, fence and all.
    const out = assembleMarkdownFile(parsed.frontmatter, 'new body', {
      rawFrontmatter: parsed.rawFrontmatter,
    });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('title: Keep me');
    expect(out).toContain('\tbad: indentation');
    expect(out).toContain('new body');
  });

  it('1.1 — preserves a non-object (top-level scalar) frontmatter block', () => {
    const src = ['---', 'just a bare string', '---', 'body'].join('\n');
    const parsed = parseMarkdownFile(src);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
    const out = assembleMarkdownFile(parsed.frontmatter, 'edited', {
      rawFrontmatter: parsed.rawFrontmatter,
    });
    expect(out).toContain('just a bare string');
    expect(out.startsWith('---\n')).toBe(true);
  });

  it('1.2 — a clean body-only save emits the frontmatter bytes verbatim (comment + key order kept)', () => {
    const src = ['---', '# pinned — keep this comment', 'zeta: 1', 'alpha: 2', '---', 'old body'].join('\n');
    const parsed = parseMarkdownFile(src);
    const out = assembleMarkdownFile(parsed.frontmatter, 'new body', {
      rawFrontmatter: parsed.rawFrontmatter,
      frontmatterDirty: false,
    });
    expect(out).toBe(
      ['---', '# pinned — keep this comment', 'zeta: 1', 'alpha: 2', '---', 'new body', ''].join('\n'),
    );
  });

  it('1.2 — preserves CRLF inside the frontmatter block on a clean save', () => {
    const src = '---\r\ntitle: x\r\ntags: [a]\r\n---\r\nold';
    const parsed = parseMarkdownFile(src);
    const out = assembleMarkdownFile(parsed.frontmatter, 'new body', {
      rawFrontmatter: parsed.rawFrontmatter,
      frontmatterDirty: false,
    });
    expect(out.startsWith('---\r\n')).toBe(true);
    expect(out).toContain('title: x\r\ntags: [a]');
    expect(out).toContain('\r\n---\r\nnew body');
  });

  it('1.2 — re-serialises (dumps) the object when frontmatter is dirty', () => {
    // FM actually changed, so the captured raw bytes are stale and must NOT win.
    const out = assembleMarkdownFile({ title: 'Foo', status: 'done' }, 'body', {
      rawFrontmatter: 'title: Foo', // stale raw, missing `status`
      frontmatterDirty: true,
    });
    expect(out).toContain('title: Foo');
    expect(out).toContain('status: done'); // the new key is present → re-dumped
  });

  it('a clean save with no raw frontmatter falls back to the object dump', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body', { frontmatterDirty: false });
    expect(out).toContain('title: Foo');
    expect(out.startsWith('---\n')).toBe(true);
  });
});

describe('markdownSync — assembleMarkdownFile', () => {
  it('emits body unchanged when frontmatter is empty', () => {
    const out = assembleMarkdownFile({}, 'just text');
    expect(out).toBe('just text');
  });

  it('emits frontmatter + body for non-empty frontmatter', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('title: Foo');
    expect(out).toContain('\nbody');
  });

  it('drops null and undefined frontmatter entries', () => {
    const out = assembleMarkdownFile(
      { title: 'Foo', priority: null as unknown as string, status: undefined },
      'body',
    );
    expect(out).toContain('title: Foo');
    expect(out).not.toContain('priority');
    expect(out).not.toContain('status');
  });

  it('does NOT promote inline #tags from the body into frontmatter', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'see #alpha and #beta');
    expect(out).not.toContain('tags');
    expect(out).toContain('see #alpha and #beta');
  });

  it('drops an empty tags array from frontmatter', () => {
    const out = assembleMarkdownFile({ title: 'Foo', tags: [] }, 'body');
    expect(out).not.toContain('tags');
    expect(out).toContain('title: Foo');
  });

  it('round-trips frontmatter through parse → assemble', () => {
    const src = '---\ntitle: Foo\nstatus: done\ntags:\n  - a\n  - b\n---\n# h\n\nbody';
    const r = parseMarkdownFile(src);
    const out = assembleMarkdownFile(r.frontmatter, r.body);
    const r2 = parseMarkdownFile(out);
    expect(r2.frontmatter.title).toBe('Foo');
    expect(r2.frontmatter.status).toBe('done');
    expect(r2.frontmatter.tags).toEqual(['a', 'b']);
    // gray-matter.stringify normalises a trailing newline; trim for comparison.
    expect(r2.body.trimEnd()).toBe('# h\n\nbody');
  });

  it('injects contentId as id when frontmatter has no id', () => {
    const out = assembleMarkdownFile({}, 'body', { contentId: 'doc_abc123' });
    const r = parseMarkdownFile(out);
    expect(r.frontmatter.id).toBe('doc_abc123');
    expect(r.body.trimEnd()).toBe('body');
  });

  it('preserves an existing id in frontmatter (no overwrite)', () => {
    const out = assembleMarkdownFile({ id: 'external_xyz' }, 'body', { contentId: 'doc_abc123' });
    const r = parseMarkdownFile(out);
    expect(r.frontmatter.id).toBe('external_xyz');
  });

  it('does not inject id when no contentId provided', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body');
    const r = parseMarkdownFile(out);
    expect(r.frontmatter.id).toBeUndefined();
    expect(r.frontmatter.title).toBe('Foo');
  });

  it('round-trips an injected id through parse → assemble', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body', { contentId: 'doc_xyz' });
    const r = parseMarkdownFile(out);
    expect(r.frontmatter.id).toBe('doc_xyz');
    expect(r.frontmatter.title).toBe('Foo');
    // Re-assembling without contentId should still keep the id (it's in the FM).
    const out2 = assembleMarkdownFile(r.frontmatter, r.body);
    const r2 = parseMarkdownFile(out2);
    expect(r2.frontmatter.id).toBe('doc_xyz');
  });

  // Regression: gray-matter.stringify uses Node's Buffer global, which is
  // undefined in the Vite-bundled renderer. The previous implementation
  // crashed `writeMarkdownToDisk` with `ReferenceError: Buffer is not
  // defined` on every keystroke. The replacement emitter must work with
  // Buffer absent.
  it('does not depend on the Node Buffer global (renderer compat)', () => {
    const original = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as { Buffer?: unknown }).Buffer;
      const out = assembleMarkdownFile(
        { title: 'Foo', tags: ['a', 'b'] },
        'body',
        { contentId: 'doc_xyz' },
      );
      expect(out).toMatch(/^---\n/);
      expect(out).toContain('title: Foo');
      expect(out).toContain('id: doc_xyz');
      expect(out).toContain('body');
    } finally {
      if (original !== undefined) (globalThis as { Buffer?: unknown }).Buffer = original;
    }
  });
});

/**
 * Phase 20 / S6 — caret preservation. Without this, an external edit hitting
 * `setContent` underneath an open editor resets the cursor to position 0 and
 * the user loses their place mid-keystroke. The stub editor below covers the
 * tiny API surface `loadMarkdownIntoEditor` actually touches so we can assert
 * the snapshot+restore flow without hauling in a full TipTap instance.
 */
interface StubEditor {
  isDestroyed: boolean;
  isFocused: boolean;
  state: {
    selection: { from: number; to: number };
    doc: { content: { size: number } };
  };
  commands: {
    setContent: (body: string, emit: boolean) => void;
    setTextSelection: (sel: { from: number; to: number }) => void;
    focus: (pos?: unknown, options?: { scrollIntoView?: boolean }) => void;
  };
}

function makeStubEditor(opts: {
  initialFrom: number;
  initialTo: number;
  newDocSize: number;
  focused?: boolean;
}): StubEditor & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const stub: StubEditor & { calls: typeof calls } = {
    isDestroyed: false,
    isFocused: opts.focused ?? false,
    state: {
      selection: { from: opts.initialFrom, to: opts.initialTo },
      doc: { content: { size: 9999 } }, // any size before setContent
    },
    commands: {
      setContent: (body, emit) => {
        calls.push(['setContent', { body, emit }]);
        stub.state.doc.content.size = opts.newDocSize;
      },
      setTextSelection: (sel) => {
        calls.push(['setTextSelection', sel]);
        stub.state.selection = { from: sel.from, to: sel.to };
      },
      focus: (pos, options) => {
        calls.push(['focus', { pos, options }]);
      },
    },
    calls,
  };
  return stub;
}

describe('markdownSync — loadMarkdownIntoEditor caret preservation', () => {
  it('does NOT snapshot/restore when preserveSelection is omitted', () => {
    const stub = makeStubEditor({ initialFrom: 10, initialTo: 12, newDocSize: 50 });
    loadMarkdownIntoEditor(stub as unknown as Editor, 'new body');
    const kinds = stub.calls.map((c) => c[0]);
    expect(kinds).toEqual(['setContent']);
  });

  it('restores selection in place when both ends still fit the new doc', () => {
    const stub = makeStubEditor({ initialFrom: 7, initialTo: 9, newDocSize: 50 });
    loadMarkdownIntoEditor(stub as unknown as Editor, 'new body', { preserveSelection: true });
    const sel = stub.calls.find((c) => c[0] === 'setTextSelection');
    expect(sel?.[1]).toEqual({ from: 7, to: 9 });
  });

  it('clamps the restored selection when the new doc is shorter', () => {
    // Editor had cursor at position 200/220; external edit shrinks doc to 50.
    const stub = makeStubEditor({ initialFrom: 200, initialTo: 220, newDocSize: 50 });
    loadMarkdownIntoEditor(stub as unknown as Editor, 'tiny', { preserveSelection: true });
    const sel = stub.calls.find((c) => c[0] === 'setTextSelection');
    expect(sel?.[1]).toEqual({ from: 50, to: 50 });
  });

  it('refocuses the editor when it had focus before the swap', () => {
    const stub = makeStubEditor({
      initialFrom: 3,
      initialTo: 3,
      newDocSize: 50,
      focused: true,
    });
    loadMarkdownIntoEditor(stub as unknown as Editor, 'new body', { preserveSelection: true });
    const focusCall = stub.calls.find((c) => c[0] === 'focus');
    expect(focusCall?.[1]).toEqual({ pos: undefined, options: { scrollIntoView: false } });
  });

  it('does not refocus when the editor was not focused', () => {
    const stub = makeStubEditor({
      initialFrom: 3,
      initialTo: 3,
      newDocSize: 50,
      focused: false,
    });
    loadMarkdownIntoEditor(stub as unknown as Editor, 'new body', { preserveSelection: true });
    expect(stub.calls.find((c) => c[0] === 'focus')).toBeUndefined();
  });

  it('skips when the editor is destroyed', () => {
    const stub = makeStubEditor({ initialFrom: 0, initialTo: 0, newDocSize: 0 });
    stub.isDestroyed = true;
    loadMarkdownIntoEditor(stub as unknown as Editor, 'x', { preserveSelection: true });
    expect(stub.calls).toEqual([]);
  });
});

/**
 * Phase 27 / A4 — round-trip detection. The helper normalises both sides so
 * cosmetic differences (line endings, trailing whitespace, blank lines, list
 * bullet style) don't trigger a false-positive "lossy" verdict. Anything
 * that survives normalisation and still differs is real syntax that
 * tiptap-markdown couldn't preserve and a write would silently drop.
 */
describe('markdownSync — isLossyMarkdownRoundTrip', () => {
  it('returns false for identical strings', () => {
    expect(isLossyMarkdownRoundTrip('# hello', '# hello')).toBe(false);
  });

  it('returns false when only line endings differ (CRLF vs LF)', () => {
    expect(isLossyMarkdownRoundTrip('a\r\nb\r\n', 'a\nb\n')).toBe(false);
    expect(isLossyMarkdownRoundTrip('a\rb', 'a\nb')).toBe(false);
  });

  it('returns false when only trailing whitespace per line differs', () => {
    expect(isLossyMarkdownRoundTrip('foo   \nbar\t\n', 'foo\nbar\n')).toBe(false);
  });

  it('returns false when only blank-line counts differ within paragraph separators', () => {
    expect(isLossyMarkdownRoundTrip('a\n\n\n\nb', 'a\n\nb')).toBe(false);
  });

  it('returns false when only list bullet style differs (`*` vs `-` vs `+`)', () => {
    expect(isLossyMarkdownRoundTrip('* item\n* other', '- item\n- other')).toBe(false);
    expect(isLossyMarkdownRoundTrip('+ item', '- item')).toBe(false);
  });

  it('returns false when only emphasis delimiter style differs (underscore vs asterisk)', () => {
    // prosemirror-markdown serialises emphasis with asterisks; an Obsidian
    // file using underscores must NOT be flagged lossy (audit 2.4) and held
    // read-only just because the delimiter style differs.
    expect(isLossyMarkdownRoundTrip('a _italic_ b', 'a *italic* b')).toBe(false);
    expect(isLossyMarkdownRoundTrip('a __bold__ b', 'a **bold** b')).toBe(false);
    expect(isLossyMarkdownRoundTrip('_italic_', '*italic*')).toBe(false);
    // Intraword underscores (snake_case) are not emphasis and survive, while a
    // real underscore emphasis in the same line still normalises to a match.
    expect(isLossyMarkdownRoundTrip('_em_ and snake_case', '*em* and snake_case')).toBe(false);
  });

  it('returns true when an Obsidian callout is dropped', () => {
    const input = '> [!note]\n> body of callout';
    const tiptapOutput = '> body of callout'; // callout marker stripped
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when a math block is stripped', () => {
    const input = 'before\n$$\nx^2 + y^2 = z^2\n$$\nafter';
    const tiptapOutput = 'before\nafter'; // math block stripped
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when ==highlight== syntax is lost', () => {
    const input = 'plain ==highlighted== plain';
    const tiptapOutput = 'plain highlighted plain'; // == markers gone
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when content is shorter by a non-trivial chunk', () => {
    expect(isLossyMarkdownRoundTrip('hello there', 'hello')).toBe(true);
  });

  it('treats empty input as non-lossy (no content, no detection)', () => {
    expect(isLossyMarkdownRoundTrip('', '')).toBe(false);
  });

  // Phase Sprint B / B1 — Setext H1/H2 should compare equal to their ATX
  // equivalents. `tiptap-markdown` always emits ATX (`# Foo`); without the
  // normalisation step every Setext-styled file would be flagged as lossy
  // and silently switched to read-only, preventing the user from editing
  // their own headings.
  it('returns false for Setext H1 input matched by ATX output', () => {
    const input = 'Heading One\n===========\n\nbody';
    const tiptapOutput = '# Heading One\n\nbody';
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(false);
  });

  it('returns false for Setext H2 input matched by ATX output', () => {
    const input = 'Heading Two\n-----------\n\nbody';
    const tiptapOutput = '## Heading Two\n\nbody';
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(false);
  });

  it('returns false for Setext H1 with trailing whitespace on the underline', () => {
    const input = 'Heading One\n=====   \n\nbody';
    const tiptapOutput = '# Heading One\n\nbody';
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(false);
  });

  // Phase 40 / 40.1 — coverage for additional Obsidian-flavoured syntax that
  // `tiptap-markdown` (markdown-it under the hood) does not understand. The
  // round-trip detector should flag any of these as lossy when tiptap drops
  // or transforms them; a false negative here would let the next debounced
  // write silently destroy the user's data.

  it('returns true when an Obsidian footnote reference is dropped', () => {
    const input = 'See note[^1]\n\n[^1]: footnote definition';
    const tiptapOutput = 'See note\n\nfootnote definition'; // [^1] markers gone
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when only the footnote definition is dropped', () => {
    const input = 'See note[^1]\n\n[^1]: footnote definition';
    const tiptapOutput = 'See note[^1]'; // definition line stripped
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when an Obsidian comment is stripped', () => {
    const input = 'visible %%hidden comment%% also visible';
    const tiptapOutput = 'visible  also visible'; // %% markers + body dropped
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when a block-level Obsidian comment is stripped', () => {
    const input = 'before\n\n%%\nmulti-line\ncomment\n%%\n\nafter';
    const tiptapOutput = 'before\n\nafter'; // entire comment block gone
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when a dataview code block loses its language tag', () => {
    const input = '```dataview\nTABLE file.name\nFROM #note\n```';
    const tiptapOutput = '```\nTABLE file.name\nFROM #note\n```'; // language tag gone
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when a dataview code block is dropped entirely', () => {
    const input = 'before\n\n```dataview\nTABLE file.name\nFROM #note\n```\n\nafter';
    const tiptapOutput = 'before\n\nafter';
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when an Obsidian wiki-link is dropped or transformed', () => {
    const input = 'see [[Other Note]] for details';
    const tiptapOutput = 'see Other Note for details'; // wiki-link markers gone
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when an Obsidian image embed is dropped', () => {
    const input = 'before\n![[image.png]]\nafter';
    const tiptapOutput = 'before\nafter'; // embed dropped
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when a tag inside a comment leaks into the body', () => {
    // Edge case: tiptap might preserve `#tagInComment` but drop the `%%…%%`
    // wrapper, turning a hidden tag into a visible body tag.
    const input = 'note %%#hidden-tag%% body';
    const tiptapOutput = 'note #hidden-tag body';
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });

  it('returns true when an inline math block is dropped', () => {
    const input = 'before $x^2$ after';
    const tiptapOutput = 'before  after'; // inline math removed
    expect(isLossyMarkdownRoundTrip(input, tiptapOutput)).toBe(true);
  });
});

describe('markdownSync — loadMarkdownIntoEditor lossy detection', () => {
  it('reports lossy=false when stub editor lacks markdown storage', () => {
    // Stub editors have no `storage.markdown.getMarkdown` — the defensive
    // try/catch must default to non-lossy so legitimate test paths don't
    // trip the read-only flag.
    const stub = makeStubEditor({ initialFrom: 0, initialTo: 0, newDocSize: 50 });
    const result = loadMarkdownIntoEditor(stub as unknown as Editor, '# heading\n\nbody');
    expect(result.lossy).toBe(false);
  });

  it('reports lossy=false for empty body even with no storage', () => {
    const stub = makeStubEditor({ initialFrom: 0, initialTo: 0, newDocSize: 0 });
    const result = loadMarkdownIntoEditor(stub as unknown as Editor, '');
    expect(result.lossy).toBe(false);
  });

  it('reports lossy=true when the storage stub returns a divergent round-trip', () => {
    // Simulate a tiptap-markdown round-trip that loses the callout syntax.
    const stub = makeStubEditor({ initialFrom: 0, initialTo: 0, newDocSize: 50 });
    (stub as unknown as Record<string, unknown>).storage = {
      markdown: { getMarkdown: () => '> body only' },
    };
    const result = loadMarkdownIntoEditor(
      stub as unknown as Editor,
      '> [!note]\n> body only',
    );
    expect(result.lossy).toBe(true);
  });
});

