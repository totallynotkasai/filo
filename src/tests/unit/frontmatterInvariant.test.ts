import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import yaml from 'js-yaml';
import { parseDocument } from 'yaml';
import {
  addTagToMarkdown,
  removeTagFromMarkdown,
  rewriteTagInMarkdown,
} from '@renderer/lib/vault/tagRewriter';
import { parseMarkdownFile, assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';
import { valuesEqual } from '@renderer/lib/vault/frontmatterEngine';
import { patchFrontmatterSourceCst } from '@renderer/lib/vault/frontmatterCstModel';
import {
  applyFrontmatterDelta,
  isEmptyFrontmatterDelta,
  type FrontmatterDelta,
} from '@renderer/lib/vault/frontmatterDelta';

/**
 * 1.7 — the frontmatter data-loss invariant gate.
 *
 * Phase 1 (1.1–1.6) killed a cluster of silent-frontmatter-loss bugs. This
 * suite is the standing guard that no write path reintroduces the class: for a
 * corpus of HOSTILE frontmatter (CRLF, tabs, comments, anchors, quoted /
 * special-char / numeric / bool tags, flow / block / scalar shapes, duplicate
 * keys) PLUS a fast-check fuzzer, every tag op and the body-only save path must
 * either preserve the user's data losslessly OR refuse the write — NEVER
 * silently drop a key, corrupt the YAML, or touch the body.
 *
 * Wired into CI as its own gate via `scripts/gates:frontmatter-invariant`
 * (`npm run ci:frontmatter-invariant`) so it can't be dropped from `ci:verify`.
 */

interface FmRegion {
  raw: string;
  body: string;
  has: boolean;
}

function fmRegion(md: string): FmRegion {
  // Audit-4 DI-02 — a leading UTF-8 BOM precedes the opening `---` fence, so
  // strip it before matching (and from the no-frontmatter body). Without this a
  // BOM file reads as "no frontmatter" here and the duplicate-frontmatter-block
  // bug (a tag-add prepending a second block) slips through the invariant.
  const s = md.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(s);
  return m ? { raw: m[1], body: m[2] ?? '', has: true } : { raw: '', body: s, has: false };
}

/**
 * Parses a frontmatter block with the `yaml` package (`parseDocument().toJS()`) —
 * the SAME single parser the read path (`parseMarkdownFile`) and the CST write
 * engine use. The object this builds therefore carries the value types the engine
 * compares against (an untouched `1_000` is the STRING "1_000" here, not the
 * number js-yaml CORE would give), so it serves BOTH as the `nextObj` an
 * object-patch op starts from and as the oracle that re-parses the engine's
 * output — the whole object-patch invariant is single-parser, faithful to
 * production. Like a CORE read it keeps DI-01 / DI-05 (the `yaml` core schema
 * resolves no timestamp / merge tag, so an unquoted date stays a string and `<<`
 * a literal key). Returns null on any parse error / non-mapping root.
 */
function parseFm(raw: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) return null;
    const o = doc.toJS();
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tryParseKeys(raw: string): { ok: boolean; keys: Set<string> } {
  try {
    const o = yaml.load(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return { ok: true, keys: new Set(Object.keys(o as Record<string, unknown>)) };
    }
    return { ok: true, keys: new Set() };
  } catch {
    return { ok: false, keys: new Set() };
  }
}

/**
 * The core invariant: `out` is a SAFE result of a tag op on `input`.
 *  - `out === input` → refusal / no-op (always safe).
 *  - else the body must be untouched, and either:
 *      • input FM parsed cleanly → out FM parses cleanly and keeps every
 *        non-`tags` key, OR
 *      • input FM did NOT parse  → out preserves every non-tags, non-sequence
 *        FM line verbatim (the line rewriter only edits the tags field).
 */
function assertSafeTagOp(input: string, out: string, label: string): void {
  if (out === input) return; // refusal / no-op — always safe

  const inR = fmRegion(input);
  const outR = fmRegion(out);
  expect(outR.body, `${label}: body changed`).toBe(inR.body);

  if (!inR.has) {
    // Input had no frontmatter; an op may ADD one (addTag). If so it must parse.
    if (outR.has) {
      expect(tryParseKeys(outR.raw).ok, `${label}: produced unparseable new frontmatter`).toBe(true);
    }
    return;
  }

  const inParse = tryParseKeys(inR.raw);
  if (inParse.ok) {
    const outParse = tryParseKeys(outR.raw);
    expect(outParse.ok, `${label}: a parseable frontmatter became unparseable`).toBe(true);
    for (const k of inParse.keys) {
      if (k === 'tags') continue; // tags is the field under edit
      expect(outParse.keys.has(k), `${label}: silently dropped key "${k}"`).toBe(true);
    }
    // Audit-4 DI-01 / DI-05 — beyond "key still present", a tag op must not
    // REFORMAT a non-tags value: an unquoted date must not become an ISO
    // timestamp, a `<<` merge key must not be inlined. Compare values parsed with
    // the `yaml` package (the read path's + write engine's single parser). A
    // folded `>` scalar may be cosmetically reflowed (DI-06, accepted) but its
    // PARSED value is identical, so it holds.
    const inObj = parseFm(inR.raw);
    const outObj = parseFm(outR.raw);
    if (inObj && outObj) {
      for (const k of Object.keys(inObj)) {
        if (k === 'tags') continue;
        expect(outObj[k], `${label}: reformatted the value of non-tags key "${k}"`).toEqual(inObj[k]);
      }
    }
    return;
  }

  // Unparseable input the op chose to rewrite: the line rewriter must have left
  // every non-tags line byte-identical (tags-field lines may legitimately move).
  const outLines = new Set(outR.raw.split('\n').map((l) => l.replace(/\r$/, '')));
  for (const rawLine of inR.raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (/^tags\s*:/.test(line)) continue; // tags header
    if (/^\s*-\s/.test(line)) continue; // a sequence item (possibly tags')
    expect(outLines.has(line), `${label}: dropped frontmatter line "${line}" from an unparseable block`).toBe(
      true,
    );
  }
}

const TAG_OPS: ReadonlyArray<{ name: string; run: (s: string) => string }> = [
  { name: 'addTag(fresh)', run: (s) => addTagToMarkdown(s, 'freshtag') },
  { name: 'addTag(foo)', run: (s) => addTagToMarkdown(s, 'foo') },
  { name: 'remove(foo)', run: (s) => removeTagFromMarkdown(s, 'foo') },
  { name: 'remove(@home)', run: (s) => removeTagFromMarkdown(s, '@home') },
  { name: 'rename(foo->x)', run: (s) => rewriteTagInMarkdown(s, 'foo', 'x') },
  { name: 'rename(foo->@evil)', run: (s) => rewriteTagInMarkdown(s, 'foo', '@evil') },
];

const HOSTILE_CORPUS: ReadonlyArray<{ label: string; md: string }> = [
  { label: 'block LF', md: '---\ntitle: X\ntags:\n  - foo\n  - bar\n---\nbody\n' },
  {
    label: 'block CRLF, tags non-last',
    md: '---\r\ntitle: X\r\ntags:\r\n  - foo\r\n  - bar\r\naliases:\r\n  - mn\r\n---\r\nbody\r\n',
  },
  { label: 'flow LF', md: '---\ntitle: X\ntags: [foo, bar]\n---\nbody\n' },
  { label: 'scalar string', md: '---\ntitle: X\ntags: foo, bar\n---\nbody\n' },
  { label: 'comment, no tags', md: '---\n# keep me\ntitle: X\n---\nbody\n' },
  { label: 'quoted special sibling (flow)', md: '---\ntitle: X\ntags: ["@home", foo]\n---\nbody\n' },
  { label: 'quoted special sibling (block)', md: "---\ntags:\n  - '@home'\n  - foo\n---\nbody\n" },
  { label: 'numeric/bool sibling keys', md: '---\ncount: 3\nflag: true\ntags:\n  - foo\n---\nbody\n' },
  { label: 'aliased tags', md: '---\ncommon: &x\n  - a\ntags: *x\n---\nbody\n' },
  { label: 'anchored tags', md: '---\ntags: &t [foo, bar]\n---\nbody\n' },
  // H2 (Audit-13) — UNRESOLVABLE alias shapes: each parses with `errors.length
  // === 0` but THROWS in `toJS()` resolving the dangling reference (verified
  // against yaml@2.9). The read returns `{}` + the raw bytes, so every op must
  // keep-raw or refuse — never dump over the poison block.
  { label: 'unresolved forward alias (toJS throws)', md: '---\ntitle: X\ntags: *missing\n---\nbody\n' },
  { label: 'missing-anchor merge (toJS throws)', md: '---\nwidget:\n  <<: *gone\ntitle: X\n---\nbody\n' },
  { label: 'alias-in-seq missing anchor (toJS throws)', md: '---\nlist:\n  - *nope\ntitle: X\n---\nbody\n' },
  { label: 'duplicate key (unparseable)', md: '---\ntitle: X\ntitle: Y\ntags:\n  - foo\n---\nbody\n' },
  { label: 'tab indent (unparseable)', md: '---\ntitle: X\n\tbad: tab\ntags:\n  - foo\n---\nbody\n' },
  // Audit-4 DI-01 / DI-02 / DI-05 / DI-06 — the inputs that previously slipped
  // through this invariant (the corruption was a reformatted VALUE / a BOM
  // duplicate block, neither of which the pre-Audit-4 assertions detected).
  { label: 'unquoted date-only', md: '---\ncreated: 2025-01-15\ntags:\n  - foo\n---\nbody\n' },
  { label: 'unquoted date-time', md: '---\ncreated: 2025-01-15T10:30:00\ntags:\n  - foo\n---\nbody\n' },
  { label: 'leading BOM', md: '﻿---\ntitle: X\ntags:\n  - foo\n---\nbody\n' },
  {
    label: 'leading BOM + CRLF',
    md: '﻿---\r\ntitle: X\r\ntags:\r\n  - foo\r\n---\r\nbody\r\n',
  },
  {
    label: 'merge key (<<)',
    md: '---\ndefaults: &d\n  color: red\nwidget:\n  <<: *d\n  size: big\ntags:\n  - foo\n---\nbody\n',
  },
  { label: 'folded > scalar', md: '---\nsummary: >\n  line one\n  line two\ntags:\n  - foo\n---\nbody\n' },
  { label: 'special-char tags on BOM', md: '﻿---\ntags:\n  - "@home"\n  - foo\n---\nbody\n' },
  // Audit-16 Phase 5 — corpus gaps the ninth audit surfaced:
  //  5.1 — `tags: []` on disk (a common Obsidian/template shape) must survive
  //        any UNRELATED edit byte-for-byte (the unconditional empty-tags drop
  //        predated and bypassed the 1.1 baseline rescue, which covers `null`).
  //  5.5 — an alias INSIDE the tags collection (the old anchored check only
  //        inspected the START of the header value) — skip, never dump.
  //  5.4 — a NON-SCALAR mapping key (`[a, b]: x`): `toJS()` stringifies it, so
  //        the object view is unfaithful — the engine refuses, file untouched.
  { label: 'empty tags array on disk', md: '---\ntitle: X\ntags: []\n---\nbody\n' },
  { label: 'alias inside tags collection (flow)', md: '---\nkeep: &s shared\ntags: [*s]\n---\nbody\n' },
  {
    label: 'alias inside tags collection (block item)',
    md: '---\nkeep: &s shared\ntags:\n  - *s\n---\nbody\n',
  },
  { label: 'non-scalar seq key sibling', md: '---\n[a, b]: x\ntitle: X\ntags:\n  - foo\n---\nbody\n' },
  { label: 'non-scalar map key sibling', md: '---\n{k: 1}: x\ntitle: X\ntags:\n  - foo\n---\nbody\n' },
  // Audit-18 3.2 — a trailing `|+` keep-chomped block scalar OWNS the FM's
  // trailing blank line as part of its value. A tag op (or a body-only save)
  // must not collapse that separator newline (the pre-fix `reassemble` did,
  // silently changing `notes`). Last key, so the blank is its EOF-keep.
  { label: 'trailing |+ keep-chomped scalar', md: '---\ntags:\n  - foo\nnotes: |+\n  hello\n\n---\nbody\n' },
  { label: 'no frontmatter', md: 'just a body, no frontmatter\n' },
  { label: 'empty', md: '' },
];

describe('frontmatter data-loss invariant — hostile corpus (1.7)', () => {
  for (const { label, md } of HOSTILE_CORPUS) {
    for (const op of TAG_OPS) {
      it(`${op.name} never silently loses data on: ${label}`, () => {
        assertSafeTagOp(md, op.run(md), `${op.name} / ${label}`);
      });
    }
  }

  // 1.1 + 1.2 — a body-only save must emit the captured frontmatter bytes
  // verbatim (never re-dump, never drop a fence it couldn't parse).
  for (const { label, md } of HOSTILE_CORPUS) {
    it(`body-only save preserves the frontmatter block byte-for-byte on: ${label}`, () => {
      const parsed = parseMarkdownFile(md);
      if (!parsed.hasFrontmatter) return; // nothing to preserve
      const out = assembleMarkdownFile(parsed.frontmatter, 'A WHOLLY NEW BODY', {
        rawFrontmatter: parsed.rawFrontmatter,
        frontmatterDirty: false,
      });
      const reg = fmRegion(out);
      expect(reg.has, `${label}: body-only save dropped the fence`).toBe(true);
      expect(reg.raw, `${label}: body-only save mutated frontmatter`).toBe(parsed.rawFrontmatter);
    });
  }
});

/**
 * L1 (Audit-12) — the empty-FM safety-net split, pinned in the invariant
 * corpus. When the live object is `{}` but the source HAD a block, the two
 * reasons need OPPOSITE handling: a PARSEABLE block must honour the clear
 * (drop the keys) while an UNPARSEABLE one is kept verbatim (data-loss
 * avoidance). The old safety net reverted BOTH to the raw bytes — silently
 * undoing a deliberate clear. These rows pin the split so it can't regress
 * back to the unconditional revert.
 */
describe('frontmatter empty-FM safety-net split (Audit-12 L1)', () => {
  it('a cleared PARSEABLE block drops to no frontmatter (no silent revert)', () => {
    const out = assembleMarkdownFile({}, 'body\n', {
      rawFrontmatter: 'title: X\ncount: 3',
      frontmatterDirty: true,
    });
    expect(fmRegion(out).has, 'cleared FM should not be reverted').toBe(false);
    expect(out).toBe('body\n');
  });

  it('a cleared block KEEPS a standalone comment (comment-only block)', () => {
    const out = assembleMarkdownFile({}, 'body\n', {
      rawFrontmatter: '# keep me\ntitle: X',
      frontmatterDirty: true,
    });
    expect(out).toBe('---\n# keep me\n---\nbody\n');
  });

  it('an UNPARSEABLE block with an empty object is preserved verbatim', () => {
    const raw = 'title: X\n\tbad: tab';
    const out = assembleMarkdownFile({}, 'body\n', {
      rawFrontmatter: raw,
      frontmatterDirty: true,
    });
    expect(fmRegion(out).has, 'unparseable fence must survive').toBe(true);
    expect(fmRegion(out).raw, 'unparseable block must be byte-preserved').toBe(raw);
  });
});

describe('frontmatter data-loss invariant — fuzz (1.7)', () => {
  // Tags drawn from a pool that mixes safe names with YAML-hostile ones
  // (special-char, hierarchy, numeric, colon) so the rewriter's quoting and
  // CRLF handling are exercised across thousands of generated shapes.
  const TAG_POOL = ['foo', 'bar', 'draft', '@home', 'project/sub', 'done', '123', 'a:b'];

  const fmArb = fc
    .record({
      // ≥1 non-tags key so the frontmatter is never the degenerate `{}` mapping.
      keys: fc.uniqueArray(fc.constantFrom('title', 'count', 'flag', 'aliases', 'date'), {
        minLength: 1,
        maxLength: 3,
      }),
      vals: fc.array(fc.oneof(fc.constant('X'), fc.integer({ min: 0, max: 99 }), fc.boolean()), {
        maxLength: 3,
      }),
      tags: fc.array(fc.constantFrom(...TAG_POOL), { maxLength: 4 }),
      flow: fc.boolean(),
      crlf: fc.boolean(),
      comment: fc.boolean(),
    })
    .map(({ keys, vals, tags, flow, crlf, comment }) => {
      const obj: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        obj[k] = vals[i] ?? 'X';
      });
      const uniqueTags = Array.from(new Set(tags));
      if (uniqueTags.length > 0) obj.tags = uniqueTags;
      // Dumping from an object guarantees a PARSEABLE input.
      let fm = yaml.dump(obj, { lineWidth: -1, flowLevel: flow ? 0 : -1 }).replace(/\n$/, '');
      if (comment) fm = `# note\n${fm}`;
      let md = `---\n${fm}\n---\nbody text\n`;
      if (crlf) md = md.replace(/\n/g, '\r\n');
      return md;
    });

  it('no tag op silently loses a key, corrupts the YAML, or edits the body', () => {
    fc.assert(
      fc.property(fmArb, (md) => {
        for (const op of TAG_OPS) {
          assertSafeTagOp(md, op.run(md), op.name);
        }
      }),
      { numRuns: 300 },
    );
  });
});

/**
 * Audit5 R1 / #3 — the BYTE-equality ratchet for the dirty frontmatter write.
 *
 * The earlier invariant compared parsed values of untouched keys, which is
 * BLIND to source canonicalisation: `02134` and `2134` parse to the same number
 * `2134`, so `toEqual` passed while the on-disk bytes silently changed. An
 * earlier engine re-serialised the whole `yaml` Document on every dirty write,
 * canonicalising every untouched PLAIN scalar — leading zeros, hex case, exponent
 * form, `+` sign, and padding all churned on a single sibling edit.
 *
 * These assertions compare the untouched keys' SOURCE LINES byte-for-byte after a
 * dirty write that changes exactly one sibling key. They fail against the old
 * whole-document re-serialise and pass only with the source-preserving splice.
 */
describe('frontmatter dirty-write preserves untouched scalar BYTES (R1 / #3)', () => {
  // One row per canonicalisation-prone value class. Each is a top-level scalar
  // whose source is NOT what a serializer would re-emit from its parsed value.
  const SCALAR_CLASSES: ReadonlyArray<{ label: string; line: string }> = [
    { label: 'leading-zero int', line: 'zip: 02134' },
    { label: 'long leading-zero (isbn)', line: 'isbn: 0306406152' },
    { label: 'uppercase hex', line: 'color: 0xFF00FF' },
    { label: 'exponent', line: 'exp: 6.022e23' },
    { label: 'octal-looking', line: 'count: 007' },
    { label: 'sexagesimal-looking', line: 'ratio: 1:30' },
    { label: 'leading plus', line: 'plus: +5' },
    { label: 'padded value', line: 'padded:   spaced value' },
    { label: 'double-quoted', line: 'quoted: "keep me"' },
    { label: 'single-quoted', line: "sq: 'literal'" },
    // M2 (Audit-6) — `1_000` / `0b1010` are the forms js-yaml CORE and the `yaml`
    // package DISAGREE on: js-yaml reads them as the NUMBERS 1000 / 10, the `yaml`
    // package keeps them as the STRINGS "1_000" / "0b1010". A second parser in the
    // loop flagged an UNTOUCHED key as changed and canonicalised it. Phase 6 put
    // the read (`parseFm` here) AND the write engine on the `yaml` package, so an
    // untouched `1_000` is the SAME string on both sides of the diff → unchanged →
    // spliced verbatim (the M2 class is structurally dead, single-parser).
    // `0o17` / `0xFF` already agree across both parsers — control cases that
    // guard the broader edge-numeric class against future drift.
    { label: 'underscore-separated int', line: 'thousands: 1_000' },
    { label: 'binary literal', line: 'flags: 0b1010' },
    { label: 'octal 0o prefix', line: 'mode: 0o17' },
    { label: 'short uppercase hex', line: 'mask: 0xFF' },
  ];

  // A single block holding every class plus a `title` sentinel to mutate.
  const FM_LINES = ['title: Old Title', ...SCALAR_CLASSES.map((c) => c.line)];
  const FM_SOURCE = FM_LINES.join('\n');
  const MD = `---\n${FM_SOURCE}\n---\nbody text\n`;

  it('a dirty write that changes one sibling leaves every other line byte-identical (via assembleMarkdownFile)', () => {
    const parsed = parseMarkdownFile(MD);
    const changedFm = { ...parsed.frontmatter, title: 'New Title' };
    // Dirty branch: pass the disk baseline as originalFrontmatter and DON'T flag
    // it clean, so assembleMarkdownFile routes through patchFrontmatterSourceCst.
    const out = assembleMarkdownFile(changedFm, 'body text', {
      originalFrontmatter: parsed.rawFrontmatter,
    });
    const outFm = fmRegion(out).raw;
    const outLines = outFm.split('\n');
    const inLines = FM_SOURCE.split('\n');

    expect(outLines.length, 'line count changed').toBe(inLines.length);
    for (let i = 0; i < inLines.length; i++) {
      if (inLines[i].startsWith('title:')) {
        expect(outLines[i], 'changed key not applied').toBe('title: New Title');
        continue;
      }
      // The whole point: byte-for-byte, NOT parsed-value, equality.
      expect(outLines[i], `untouched line ${i} canonicalised`).toBe(inLines[i]);
    }
  });

  // Per-class: change a DIFFERENT sibling each time and assert THIS class's exact
  // source line survives. Catches a regression that only churns one value class.
  for (const cls of SCALAR_CLASSES) {
    it(`preserves "${cls.line}" verbatim when an unrelated key changes (${cls.label})`, () => {
      const parsed = parseMarkdownFile(MD);
      const changedFm = { ...parsed.frontmatter, title: 'Different' };
      const out = assembleMarkdownFile(changedFm, 'body text', {
        originalFrontmatter: parsed.rawFrontmatter,
      });
      expect(fmRegion(out).raw.split('\n')).toContain(cls.line);
    });
  }

  // Direct patchFrontmatterSourceCst byte check — the engine in isolation.
  it('patchFrontmatterSourceCst emits untouched scalar lines verbatim', () => {
    const parsedFm = parseFm(FM_SOURCE) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(FM_SOURCE, { ...parsedFm, title: 'X' });
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    for (const cls of SCALAR_CLASSES) {
      expect(lines, `dropped/changed "${cls.line}"`).toContain(cls.line);
    }
  });

  // A changed single-line scalar keeps its SAME-LINE trailing comment (the
  // value-only splice), and the change still applies.
  it('a changed scalar keeps its inline trailing comment', () => {
    const src = 'title: Old   # the title\nzip: 02134';
    const out = patchFrontmatterSourceCst(src, { title: 'New', zip: 2134 });
    expect(out).not.toBeNull();
    expect(out).toContain('# the title');
    expect(out).toContain('New');
    expect(out).toContain('zip: 02134');
  });
});

/**
 * Audit-6 C1 (CRITICAL) — setting a value on a BARE/empty key must re-parse.
 *
 * A bare key (`aliases:`, or `aliases: # note`) parses to a ZERO-WIDTH scalar
 * value whose CST range collapses to a point (`[n, n, n]`). The pre-fix
 * value-only splice emitted the new scalar with NO separating space:
 * `aliases:` + `home` → `aliases:home`. js-yaml then reads that as a plain
 * scalar, so the WHOLE mapping collapses (`parseMarkdownFile` → `{}`) on
 * re-read, or — with a trailing comment — the value is silently mangled to the
 * string `home# note`. Either way the entire frontmatter block round-trips to
 * disk corrupt while the indicator says "saved".
 *
 * This is exactly the case the `ci:frontmatter-invariant` corpus never had: it
 * only ever EDITED `tags`, and never SET a value on a bare empty key. These
 * cases close that blind spot. The matrix is every bare key × position ×
 * with/without trailing comment × with/without trailing newline. Each asserts
 * the output (1) re-parses, (2) carries the correct new value, and (3) keeps its
 * sibling keys — the corruption took out the whole block, not just the key.
 */
describe('frontmatter bare-empty-key value-set re-parses (Audit-6 C1)', () => {
  const BARE_KEYS = ['aliases', 'tags', 'cssclasses'] as const;
  const SIBLING_BEFORE = 'title: Note';
  const SIBLING_AFTER = 'count: 3';
  type Position = 'first' | 'middle' | 'last';

  function buildSource(
    bareKey: string,
    position: Position,
    withComment: boolean,
    withTrailingNl: boolean,
  ): string {
    const bareLine = withComment ? `${bareKey}: # a note` : `${bareKey}:`;
    const lines =
      position === 'first'
        ? [bareLine, SIBLING_BEFORE, SIBLING_AFTER]
        : position === 'middle'
          ? [SIBLING_BEFORE, bareLine, SIBLING_AFTER]
          : [SIBLING_BEFORE, SIBLING_AFTER, bareLine];
    return lines.join('\n') + (withTrailingNl ? '\n' : '');
  }

  for (const bareKey of BARE_KEYS) {
    for (const position of ['first', 'middle', 'last'] as Position[]) {
      for (const withComment of [false, true]) {
        for (const withTrailingNl of [false, true]) {
          const label = `${bareKey} @${position}${withComment ? ' +comment' : ''} ${withTrailingNl ? '+nl' : '-nl'}`;

          it(`patchFrontmatterSourceCst: set value on bare "${label}" re-parses & is correct`, () => {
            const src = buildSource(bareKey, position, withComment, withTrailingNl);
            const current = yaml.load(src, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
            const out = patchFrontmatterSourceCst(src, { ...current, [bareKey]: 'home' });

            expect(out, `${label}: engine refused (returned null)`).not.toBeNull();
            // (1) Output RE-PARSES — the bug made js-yaml throw / collapse to a scalar.
            expect(tryParseKeys(out!).ok, `${label}: output does not re-parse`).toBe(true);

            const reObj = yaml.load(out!, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
            // (2) The bare key now holds the value we set.
            expect(reObj[bareKey], `${label}: bare-key value wrong`).toBe('home');
            // (3) The whole block survived — siblings keep their values.
            expect(reObj.title, `${label}: lost sibling "title"`).toBe('Note');
            expect(reObj.count, `${label}: lost sibling "count"`).toBe(3);
          });
        }
      }
    }
  }

  // End-to-end through the real dirty-write path (`assembleMarkdownFile` with a
  // disk baseline) — the exact route a Properties/metadata edit takes. Proves
  // the produced `.md` file re-parses and the block did not collapse.
  it('assembleMarkdownFile dirty-write on a bare key produces a re-parseable file', () => {
    const md = '---\ntitle: Note\naliases:\ncount: 3\n---\nbody text\n';
    const parsed = parseMarkdownFile(md);
    const out = assembleMarkdownFile({ ...parsed.frontmatter, aliases: 'home' }, 'body text', {
      originalFrontmatter: parsed.rawFrontmatter,
    });
    const reg = fmRegion(out);
    expect(reg.has, 'dropped the fence').toBe(true);
    const reparse = parseFm(reg.raw);
    expect(reparse, 'frontmatter block collapsed / unparseable').not.toBeNull();
    expect(reparse!.aliases, 'bare-key value wrong').toBe('home');
    expect(reparse!.title, 'lost sibling "title"').toBe('Note');
    expect(reparse!.count, 'lost sibling "count"').toBe(3);
  });
});

/**
 * Audit-6 L27 — a document using YAML anchors (&a) / aliases (*a) refuses the
 * source-preserving splice (returns null), so the caller falls back to a full
 * dump. Editing the anchored value with a value-only splice would otherwise
 * rewrite only the anchor's bytes and leave every alias pointing at the stale
 * value (the object diff resolves aliases, so the change "looks" local). The
 * dump expands the alias to a concrete value — structure lost, DATA correct.
 */
describe('frontmatter anchors/aliases — splice refuses only for TOUCHED anchored keys (Audit-6 L27)', () => {
  const SRC = 'base: &b 5\nthreshold: *b\ntitle: Note';

  it('refuses when the CHANGED key carries an anchor (re-emit would dangle its aliases)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    // Edit the anchored value itself: re-emitting `base` drops `&b`, leaving
    // `threshold: *b` dangling. The engine must refuse so the caller dumps.
    const out = patchFrontmatterSourceCst(SRC, { ...current, base: 10 });
    expect(out, 'spliced an edit to the anchored key instead of refusing').toBeNull();
  });

  it('refuses when the CHANGED key is itself an alias', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(SRC, { ...current, threshold: 99 });
    expect(out).toBeNull();
  });

  it('still SPLICES an edit to an UNRELATED key, preserving anchors verbatim (no over-refusal — DI-05)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    // `title` carries no anchor/alias and `base`/`threshold` are untouched, so
    // the splice is safe and keeps `&b` / `*b` byte-for-byte.
    const out = patchFrontmatterSourceCst(SRC, { ...current, title: 'Renamed' });
    expect(out, 'over-refused a safe edit to an unrelated key').not.toBeNull();
    expect(out).toContain('&b 5');
    expect(out).toContain('threshold: *b');
    expect(out).toContain('title: Renamed');
  });

  it('the dirty-write fallback (anchored key changed) preserves DATA (structure expanded)', () => {
    const md = '---\nbase: &b 5\nthreshold: *b\ntitle: Note\n---\nbody\n';
    const parsed = parseMarkdownFile(md);
    expect(parsed.frontmatter.threshold).toBe(5); // CORE resolves the alias
    // Changing the anchored key → splice refuses → assembleMarkdownFile dumps.
    const out = assembleMarkdownFile({ ...parsed.frontmatter, base: 10 }, 'body', {
      originalFrontmatter: parsed.rawFrontmatter,
    });
    const reparse = parseFm(fmRegion(out).raw);
    expect(reparse, 'frontmatter unparseable after the anchor dump fallback').not.toBeNull();
    expect(reparse!.base).toBe(10);
    expect(reparse!.threshold, 'aliased value corrupted').toBe(5);
    expect(reparse!.title).toBe('Note');
  });
});

/**
 * Audit-6 L23 — verbatim byte preservation is TOP-LEVEL only. An untouched
 * top-level key keeps its bytes (incl. comments inside a nested block it owns);
 * a CHANGED nested collection re-serialises the whole pair, dropping comments
 * that lived inside it. Pinned so any widening of the loss is caught.
 */
describe('frontmatter nested-collection comment preservation is top-level only (Audit-6 L23)', () => {
  const SRC = 'title: Note\nmeta:\n  author: me   # who wrote it\n  year: 2020\n';

  it('keeps inner comments when the nested map is UNTOUCHED (verbatim splice)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(SRC, { ...current, title: 'Renamed' });
    expect(out).not.toBeNull();
    expect(out, 'inner comment lost on an untouched nested map').toContain('# who wrote it');
    expect(out).toContain('author: me');
  });

  it('drops inner comments when the nested map VALUE changes (documented limit)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(SRC, { ...current, meta: { author: 'you', year: 2020 } });
    expect(out).not.toBeNull();
    // Documented loss — the re-serialised nested block has no inline comment.
    expect(out).not.toContain('# who wrote it');
    const re = yaml.load(out!, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    expect((re.meta as Record<string, unknown>).author).toBe('you');
    expect(re.title, 'untouched sibling lost').toBe('Note');
  });
});

/**
 * Audit-6 L28 — a scalar→collection type change re-serialises the pair, so a
 * same-line trailing comment on the old scalar is dropped (same mechanism as
 * the bare-key C1 case). A scalar→scalar VALUE change keeps the comment via the
 * value-only splice. Pinned so the boundary doesn't widen silently.
 */
describe('frontmatter scalar→collection drops the trailing comment (Audit-6 L28)', () => {
  const SRC = 'title: Note\ntags: draft   # working copy\n';

  it('scalar→list loses the trailing comment (pinned)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(SRC, { ...current, tags: ['draft', 'final'] });
    expect(out).not.toBeNull();
    expect(out, 'scalar→collection unexpectedly kept the comment').not.toContain('# working copy');
    const re = yaml.load(out!, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    expect(re.tags).toEqual(['draft', 'final']);
    expect(re.title, 'untouched sibling lost').toBe('Note');
  });

  it('scalar→scalar value change KEEPS the trailing comment (value-only splice)', () => {
    const current = yaml.load(SRC, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    const out = patchFrontmatterSourceCst(SRC, { ...current, tags: 'final' });
    expect(out).not.toBeNull();
    expect(out, 'value-only splice dropped the trailing comment').toContain('# working copy');
    expect(out).toContain('tags: final');
  });
});

/**
 * Audit-6 Phase 5.1 / 5.2 — the GENERAL object-patch invariant (set / delete /
 * add on ANY key), not just the tag ops the original 1.7 corpus exercised.
 *
 * C1 and M2 slipped through precisely because the invariant gate only ever
 * EDITED `tags`: it never SET a value on a bare/empty key, and never carried a
 * `1_000` / `0xFF` sibling through a neighbour's edit. This section closes that
 * blind spot for the WHOLE op set. Every case asserts the three Phase 5
 * invariants on `patchFrontmatterSourceCst` (the engine where the corruption
 * lived): the output (1) RE-PARSES, (2) keeps every untouched single-line
 * scalar key BYTE-identical, and (3) carries the correct value for every key in
 * the next object (dropping exactly the deleted keys, adding no others). A
 * refusal (`null`) is always safe — the caller falls back to a lossless dump.
 */

/**
 * Returns the single top-level `key: value` SOURCE LINE for `key` when it is an
 * unambiguous single-line scalar (so its bytes can be asserted preserved), or
 * `null` for a bare/empty key, a nested block parent, a sequence parent, or an
 * absent/duplicated key (byte preservation for those is covered by re-parse +
 * value equality, not a line compare).
 */
function topLevelKeyLine(source: string, key: string): string | null {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
  const idxs: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(l)) idxs.push(i);
  });
  if (idxs.length !== 1) return null; // absent or duplicated
  const i = idxs[0];
  const line = lines[i];
  if (/:\s*(#.*)?$/.test(line)) return null; // bare key (empty value / block parent)
  const next = lines[i + 1] ?? '';
  if (/^\s+\S/.test(next) || /^\s*-\s/.test(next)) return null; // nested map / sequence
  return line;
}

/**
 * The shared Phase-5 assertion: `patchFrontmatterSourceCst(source, nextObj)` is a
 * SAFE source-preserving patch — either a refusal (`null`, caller dumps) or a
 * block satisfying the three invariants above. `current` is the `yaml`-package-
 * parsed object of `source` (the read path's + engine's single parser), so
 * "untouched" is judged with the same value semantics the engine itself uses.
 */
function assertSafeObjectPatch(
  source: string,
  current: Record<string, unknown>,
  nextObj: Record<string, unknown>,
  label: string,
): void {
  const out = patchFrontmatterSourceCst(source, nextObj);
  if (out === null) return; // refusal — caller falls back to a lossless full dump

  // (1) Output re-parses into a mapping (C1's failure mode: it didn't).
  const reObj = parseFm(out);
  expect(reObj, `${label}: output did not re-parse into a mapping`).not.toBeNull();
  if (!reObj) return;

  const expectedKeys = Object.keys(nextObj).filter((k) => nextObj[k] !== undefined);

  // (3a) Every present key carries the correct value (touched + untouched).
  for (const k of expectedKeys) {
    expect(valuesEqual(reObj[k], nextObj[k]), `${label}: wrong value for key "${k}"`).toBe(true);
  }
  // (3b) Deleted keys are gone.
  for (const k of Object.keys(current)) {
    if (!expectedKeys.includes(k)) {
      expect(k in reObj, `${label}: deleted key "${k}" survived`).toBe(false);
    }
  }
  // (3c) No extra key appeared.
  for (const k of Object.keys(reObj)) {
    expect(expectedKeys.includes(k), `${label}: unexpected key "${k}" appeared`).toBe(true);
  }

  // (2) Untouched single-line scalar keys are BYTE-identical (M2/R1's failure
  // mode: an unrelated edit canonicalised `1_000` → `1000`, `0xFF00FF` → lower).
  const outLines = new Set(out.split('\n'));
  for (const k of expectedKeys) {
    if (!(k in current)) continue; // an added key was never "untouched"
    if (!valuesEqual(current[k], nextObj[k])) continue; // changed key — not "untouched"
    const line = topLevelKeyLine(source, k);
    if (line === null) continue; // multi-line / bare — value equality already asserted
    expect(outLines.has(line), `${label}: untouched key "${k}" line canonicalised ("${line}")`).toBe(
      true,
    );
  }
}

/** A scalar guaranteed different from `v` (so a "set" op is a genuine change). */
function changedScalar(v: unknown): unknown {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  return v === 'CHANGED' ? 'CHANGED-2' : 'CHANGED';
}

const OBJECT_OPS: ReadonlyArray<{
  name: string;
  run: (cur: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    name: 'set first key',
    run: (cur) => {
      const k = Object.keys(cur)[0];
      return { ...cur, [k]: changedScalar(cur[k]) };
    },
  },
  {
    name: 'set last key',
    run: (cur) => {
      const ks = Object.keys(cur);
      const k = ks[ks.length - 1];
      return { ...cur, [k]: changedScalar(cur[k]) };
    },
  },
  {
    name: 'delete first key',
    run: (cur) => {
      const ks = Object.keys(cur);
      const out = { ...cur };
      if (ks.length > 1) delete out[ks[0]];
      return out;
    },
  },
  {
    name: 'delete last key',
    run: (cur) => {
      const ks = Object.keys(cur);
      const out = { ...cur };
      if (ks.length > 1) delete out[ks[ks.length - 1]];
      return out;
    },
  },
  { name: 'add key', run: (cur) => ({ ...cur, addedKey: 'added value' }) },
];

// Frontmatter SOURCES covering the comment-position + non-canonical-scalar gaps
// the plan enumerates (leading / standalone / trailing / inline comments;
// `02134` / `1_000` / `0xFF`; quoted scalars). Each is a raw FM block (no fences).
const PATCH_CORPUS: ReadonlyArray<{ label: string; src: string }> = [
  { label: 'leading comment', src: '# leading note\ntitle: Note\ncount: 3' },
  { label: 'standalone comment between keys', src: 'title: Note\n# section break\ncount: 3' },
  { label: 'trailing comment block', src: 'title: Note\ncount: 3\n# trailing note' },
  { label: 'inline trailing comments', src: 'title: Note   # inline a\ncount: 3   # inline b' },
  {
    label: 'non-canonical scalar siblings',
    src: 'title: Note\nzip: 02134\nthousands: 1_000\nmask: 0xFF',
  },
  { label: 'quoted scalars', src: 'title: Note\ndq: "keep me"\nsq: \'literal\'' },
  { label: 'multi-key plain', src: 'a: 1\nb: two\nc: true\nd: 4.5' },
  { label: 'single key', src: 'only: value' },
];

describe('frontmatter object-patch invariant — set / delete / add op matrix (Audit-6 Phase 5.1)', () => {
  for (const { label, src } of PATCH_CORPUS) {
    const current = parseFm(src);
    for (const op of OBJECT_OPS) {
      it(`${op.name} is safe on: ${label}`, () => {
        expect(current, `${label}: corpus source must parse`).not.toBeNull();
        if (!current) return;
        assertSafeObjectPatch(src, current, op.run(current), `${op.name} / ${label}`);
      });
    }
  }

  // Comments in leading / standalone / trailing positions survive an edit to a
  // DIFFERENT key (the engine emits the inter-key gap verbatim — comments are
  // never silently dropped).
  it('a LEADING comment survives a set on the first key', () => {
    const src = '# leading note\ntitle: Note\ncount: 3';
    const out = patchFrontmatterSourceCst(src, { title: 'Renamed', count: 3 });
    expect(out).not.toBeNull();
    expect(out, 'leading comment dropped').toContain('# leading note');
  });
  it('a STANDALONE comment between keys survives a set on a sibling', () => {
    const src = 'title: Note\n# section break\ncount: 3';
    const out = patchFrontmatterSourceCst(src, { title: 'Note', count: 4 });
    expect(out).not.toBeNull();
    expect(out, 'standalone comment dropped').toContain('# section break');
  });
  it('a TRAILING comment block survives a set', () => {
    const src = 'title: Note\ncount: 3\n# trailing note';
    const out = patchFrontmatterSourceCst(src, { title: 'Renamed', count: 3 });
    expect(out).not.toBeNull();
    expect(out, 'trailing comment dropped').toContain('# trailing note');
  });
  it('a comment documenting a DELETED key drops with it (L4 — not relocated onto a survivor)', () => {
    // `# doc for foo` documents `foo`; deleting `foo` removes the comment with it
    // rather than migrating it onto `baz` (which it never documented). A
    // SURVIVING key's comment is untouched — covered by the sibling-edit cases
    // above; this asserts only the deleted-key relocation that L4 closes.
    const src = 'title: Note\n# doc for foo\nfoo: bar\nbaz: qux';
    const out = patchFrontmatterSourceCst(src, { title: 'Note', baz: 'qux' });
    expect(out).not.toBeNull();
    expect(out, 'deleted key’s comment migrated to a surviving key').not.toContain('# doc for foo');
    const re = parseFm(out!);
    expect(re).not.toBeNull();
    expect('foo' in re!, 'foo should be deleted').toBe(false);
    expect(re!.baz, 'surviving key value preserved').toBe('qux');
  });

  // "Set a value on key K for EVERY key" (the op the original corpus lacked):
  // setting any one key leaves every OTHER (non-canonical) scalar line verbatim.
  describe('set-value on every key leaves all siblings byte-for-byte', () => {
    const SRC = 'title: Note\nzip: 02134\nthousands: 1_000\nmask: 0xFF\nflag: true';
    const current = parseFm(SRC) as Record<string, unknown>;
    for (const key of Object.keys(current)) {
      it(`set "${key}" preserves the other lines`, () => {
        assertSafeObjectPatch(SRC, current, { ...current, [key]: changedScalar(current[key]) }, `set ${key}`);
      });
    }
  });

  // CRLF × BOM matrix end-to-end through the real dirty-write path. The engine
  // normalises the FM block to LF on a dirty write (documented), so we assert
  // RE-PARSE + value-correct + untouched-scalar byte preservation + BOM
  // preservation — not CRLF preservation inside the rewritten block.
  describe('dirty set-value round-trips across CRLF × BOM (via assembleMarkdownFile)', () => {
    for (const crlf of [false, true]) {
      for (const bom of [false, true]) {
        it(`crlf=${crlf} bom=${bom}`, () => {
          let md = '---\ntitle: Old\ncount: 3\nzip: 02134\n---\nbody text\n';
          if (crlf) md = md.replace(/\n/g, '\r\n');
          if (bom) md = '﻿' + md;
          const parsed = parseMarkdownFile(md);
          const out = assembleMarkdownFile({ ...parsed.frontmatter, title: 'New' }, parsed.body, {
            originalFrontmatter: parsed.rawFrontmatter,
            bom: parsed.hadBom,
          });
          expect(out.charCodeAt(0) === 0xfeff, 'BOM preservation wrong').toBe(bom);
          const reparsed = parseMarkdownFile(out);
          expect(reparsed.hasFrontmatter, 'lost the fence').toBe(true);
          const re = parseFm(reparsed.rawFrontmatter);
          expect(re, 'frontmatter unparseable after a dirty set').not.toBeNull();
          expect(re!.title, 'changed key wrong').toBe('New');
          expect(re!.count, 'untouched count wrong').toBe(3);
          expect(
            reparsed.rawFrontmatter.replace(/\r\n/g, '\n'),
            'untouched non-canonical scalar canonicalised',
          ).toContain('zip: 02134');
          expect(reparsed.body.replace(/\r\n/g, '\n'), 'body changed').toBe('body text\n');
        });
      }
    }
  });
});

/**
 * Audit-6 Phase 5.2 — the property-based extension of the object-patch
 * invariant. Generates random frontmatter mixing EMPTY values (bare keys),
 * canonicalisation-prone numeric forms, quoted scalars, and NESTED objects,
 * builds the block from RAW source lines (so untouched siblings are NOT already
 * canonical — the byte-preservation surface R1/M2 broke), then applies a random
 * set / delete / add op and asserts the three invariants. This is the highest-
 * leverage anti-regression net: it explores shapes the hand-written corpus
 * can't enumerate.
 */
describe('frontmatter object-patch invariant — fuzz set/delete/add (Audit-6 Phase 5.2)', () => {
  // Raw scalar SOURCE texts: a mix of canonical and canonicalisation-prone
  // forms. Each is a valid single-line YAML scalar (parses, never throws).
  const SCALAR_SOURCES = [
    'X',
    'hello world',
    '42',
    '-7',
    '0',
    '3.14',
    'true',
    'false',
    '02134',
    '0306406152',
    '1_000',
    '0xFF',
    '0xFF00FF',
    '0o17',
    '6.022e23',
    '007',
    '+5',
    '1:30',
    '"double quoted"',
    "'single quoted'",
  ];

  type FieldKind = 'scalar' | 'bare' | 'nested';

  const fieldArb = fc.record({
    kind: fc.constantFrom<FieldKind>('scalar', 'scalar', 'scalar', 'bare', 'nested'),
    scalar: fc.constantFrom(...SCALAR_SOURCES),
    innerA: fc.constantFrom(...SCALAR_SOURCES),
    innerB: fc.constantFrom(...SCALAR_SOURCES),
    comment: fc.boolean(),
  });

  /** Source lines for field `i` of the given kind. */
  function fieldLines(i: number, f: { kind: FieldKind; scalar: string; innerA: string; innerB: string; comment: boolean }): string[] {
    const key = `k${i}`;
    const c = f.comment ? '   # c' + i : '';
    if (f.kind === 'bare') return [`${key}:${c}`];
    if (f.kind === 'nested') return [`${key}:`, `  ia: ${f.innerA}`, `  ib: ${f.innerB}`];
    return [`${key}: ${f.scalar}${c}`];
  }

  const docArb = fc
    .record({
      fields: fc.array(fieldArb, { minLength: 1, maxLength: 5 }),
      leadingComment: fc.boolean(),
      crlf: fc.boolean(),
      // 0 = set, 1 = delete, 2 = add
      op: fc.constantFrom(0, 1, 2),
      // index selectors (mapped into range at apply time)
      pick: fc.nat(),
      newVal: fc.oneof(
        fc.constant('new string'),
        fc.constant('multi word value'),
        fc.integer({ min: -5, max: 999 }),
        fc.boolean(),
      ),
    })
    .map((d) => {
      const lines: string[] = [];
      if (d.leadingComment) lines.push('# leading note');
      d.fields.forEach((f, i) => lines.push(...fieldLines(i, f)));
      let source = lines.join('\n');
      if (d.crlf) source = source.replace(/\n/g, '\r\n');
      return { source, op: d.op, pick: d.pick, newVal: d.newVal, n: d.fields.length };
    });

  it('no set/delete/add op loses a key, corrupts the YAML, or canonicalises an untouched scalar', () => {
    fc.assert(
      fc.property(docArb, ({ source, op, pick, newVal, n }) => {
        const current = parseFm(source);
        if (!current) return; // a generated block that didn't parse — op N/A
        const keys = Object.keys(current);
        if (keys.length === 0) return;

        let nextObj: Record<string, unknown>;
        if (op === 2) {
          nextObj = { ...current, ['added_' + (pick % 97)]: newVal };
        } else if (op === 1 && keys.length > 1) {
          nextObj = { ...current };
          delete nextObj[keys[pick % keys.length]];
        } else {
          // set (also the keys.length === 1 delete fallback)
          const k = keys[pick % keys.length];
          nextObj = { ...current, [k]: newVal };
        }
        assertSafeObjectPatch(source, current, nextObj, `op=${op} n=${n}`);
      }),
      { numRuns: 400 },
    );
  });
});

/**
 * Phase 6.0 — corpus gaps the single-parser refactor sweep surfaced. Additive
 * cases the CST engine must satisfy (they were the safety net the Phase 6 refactor
 * was validated against, retained as a permanent regression net). Each shape was
 * previously unexercised by the object-patch corpus.
 */
describe('frontmatter object-patch invariant — Phase 6.0 corpus gaps', () => {
  // GAP 1 — an anchored/aliased UNTOUCHED sibling alongside a changed key. The
  // general object-patch invariant (not just the L27 describe) must hold: the
  // splice keeps `&b` / `*b` byte-for-byte and never over-refuses a safe edit.
  it('preserves an untouched anchor/alias sibling when an unrelated key changes', () => {
    const src = 'base: &b 5\nthreshold: *b\ntitle: Note';
    const current = parseFm(src);
    expect(current).not.toBeNull();
    assertSafeObjectPatch(src, current!, { ...current!, title: 'Renamed' }, 'anchored untouched sibling');
    const out = patchFrontmatterSourceCst(src, { ...current!, title: 'Renamed' });
    expect(out).not.toBeNull();
    expect(out, 'anchor bytes not preserved').toContain('&b 5');
    expect(out, 'alias bytes not preserved').toContain('threshold: *b');
  });

  // GAP 2 — a folded `>` UNTOUCHED sibling. Its parsed value survives a sibling
  // edit (the DI-06 contract); post-R1 the legacy engine also keeps its multi-line
  // bytes verbatim (an untouched key is spliced from source, never re-folded).
  it('preserves a folded > scalar sibling on an unrelated edit', () => {
    const src = 'summary: >\n  line one\n  line two\ntitle: Note\ncount: 3';
    const current = parseFm(src);
    expect(current).not.toBeNull();
    const out = patchFrontmatterSourceCst(src, { ...current!, title: 'Renamed' });
    expect(out).not.toBeNull();
    const re = parseFm(out!);
    expect(re, 'folded-sibling edit produced unparseable FM').not.toBeNull();
    expect(re!.summary, 'folded scalar parsed value changed').toEqual(current!.summary);
    expect(re!.title).toBe('Renamed');
    expect(re!.count).toBe(3);
    expect(out, 'folded scalar header reflowed').toContain('summary: >');
    expect(out).toContain('  line one');
    expect(out).toContain('  line two');
  });

  // GAP 3 — CRLF × BOM × NESTED matrix row end-to-end through the dirty-write
  // path. The earlier CRLF×BOM matrix only carried flat scalars; this adds a
  // nested map to prove a nested value survives the line-ending + BOM round-trip.
  for (const crlf of [false, true]) {
    for (const bom of [false, true]) {
      it(`dirty set round-trips a NESTED value across crlf=${crlf} bom=${bom}`, () => {
        let md = '---\ntitle: Old\nzip: 02134\nmeta:\n  author: me\n  year: 2020\n---\nbody text\n';
        if (crlf) md = md.replace(/\n/g, '\r\n');
        if (bom) md = '﻿' + md;
        const parsed = parseMarkdownFile(md);
        const out = assembleMarkdownFile({ ...parsed.frontmatter, title: 'New' }, parsed.body, {
          originalFrontmatter: parsed.rawFrontmatter,
          bom: parsed.hadBom,
        });
        expect(out.charCodeAt(0) === 0xfeff, 'BOM preservation wrong').toBe(bom);
        const reparsed = parseMarkdownFile(out);
        const re = parseFm(reparsed.rawFrontmatter);
        expect(re, 'frontmatter unparseable after a nested dirty set').not.toBeNull();
        expect(re!.title, 'changed key wrong').toBe('New');
        const meta = re!.meta as Record<string, unknown>;
        expect(meta.author, 'nested value lost').toBe('me');
        expect(meta.year, 'nested value lost').toBe(2020);
        expect(
          reparsed.rawFrontmatter.replace(/\r\n/g, '\n'),
          'untouched non-canonical scalar canonicalised',
        ).toContain('zip: 02134');
        expect(reparsed.body.replace(/\r\n/g, '\n'), 'body changed').toBe('body text\n');
      });
    }
  }

  // GAP 4 — adding a key when the FM source ends in a trailing blank line. The
  // append must keep the prior key on its own line (no `count: 3tags:`) and the
  // block must re-parse with every key intact.
  it('appends a key after a trailing blank line without corrupting the block', () => {
    const src = 'title: Note\ncount: 3\n\n';
    const current = parseFm(src);
    expect(current).not.toBeNull();
    const out = patchFrontmatterSourceCst(src, { ...current!, tags: ['x'] });
    expect(out).not.toBeNull();
    expect(out, 'appended key concatenated onto the previous line').not.toMatch(/\S(tags):/);
    const re = parseFm(out!);
    expect(re, 'append-after-blank produced unparseable FM').not.toBeNull();
    expect(re!.tags).toEqual(['x']);
    expect(re!.title).toBe('Note');
    expect(re!.count).toBe(3);
  });
});

/**
 * Audit-14 7.5 — the Phase-4 DELTA write path across the hostile corpus.
 *
 * The invariant suite fuzzed tag-ops + the body-only save, but NOT the
 * delta-on-fresh-read path the field/popup edits take. The gateway WIRING
 * (sourcing the delta from a fresh in-chain read, not the cache) is pinned by
 * `ci:frontmatter-delta-write` + gatewayDeltaWrite.test.ts; this fuzzes the delta
 * APPLICATION across the hostile corpus. `applyDeltaLikeGateway` mirrors the
 * gateway branch exactly — parse the disk bytes (the "fresh read"), apply ONLY
 * the delta keys to `parsed.frontmatter`, assemble against the SAME fresh source
 * with the fresh-read EOL/BOM — and asserts the Phase-4 guarantee: a field edit
 * that writes a delta never silently drops the user's OTHER (untouched) keys, and
 * a block the engine can't model (unresolvable alias / `<<` merge / malformed
 * YAML) is preserved verbatim while the edit is refused. Bite-check: revert the
 * delta primitive / the engine's source-preservation → these go red.
 */
describe('frontmatter DELTA-write invariant — fresh-read delta across hostile corpus (Audit-14 7.5)', () => {
  function applyDeltaLikeGateway(diskMd: string, delta: FrontmatterDelta): string {
    // markdownFileWriter.ts `writeMarkdownFileImpl` delta branch (~L684-759).
    const parsed = parseMarkdownFile(diskMd);
    const nextFm = applyFrontmatterDelta(parsed.frontmatter, delta);
    const freshEol: '\r\n' | '\n' | undefined =
      diskMd.length === 0 ? undefined : diskMd.includes('\r\n') ? '\r\n' : '\n';
    return assembleMarkdownFile(nextFm, parsed.body, {
      bom: parsed.hadBom,
      rawFrontmatter: parsed.rawFrontmatter,
      frontmatterDirty: !isEmptyFrontmatterDelta(delta),
      originalFrontmatter: parsed.rawFrontmatter,
      eol: freshEol,
    });
  }

  /**
   * SAFE delta write: the body is untouched, and EITHER the disk FM block was
   * preserved verbatim (refusal — poison/unparseable/empty-object source) OR the
   * delta applied cleanly and every key the delta did NOT touch keeps its VALUE
   * (no silent drop). Untouched-scalar BYTE preservation is asserted by the
   * fuzzer separately, where disjoint delta keys guarantee the patch path.
   */
  function assertSafeDeltaWrite(diskMd: string, delta: FrontmatterDelta, label: string): void {
    const parsed = parseMarkdownFile(diskMd);
    const out = applyDeltaLikeGateway(diskMd, delta);
    const inR = fmRegion(diskMd);
    const outR = fmRegion(out);

    // The delta path NEVER edits body CONTENT; the only transform is assemble's
    // trailing-newline normalisation (an empty/no-final-newline body gains one).
    // Compare modulo a single trailing newline so that benign normalisation isn't
    // read as a body change, while any real content edit still trips.
    const stripEol = (s: string): string => s.replace(/\r?\n$/, '');
    expect(stripEol(outR.body), `${label}: body changed`).toBe(stripEol(inR.body));
    if (!inR.has) return; // no FM on disk — an add-FM write, nothing to preserve.

    // 5.4 (Audit-16) — a byte-identical FM block is ALWAYS safe: the engine
    // refused (e.g. a non-scalar mapping key) and the assemble kept the raw
    // bytes verbatim; the edit is dropped loudly via onFrontmatterRefused in
    // the real gateway. Nothing was lost, so there's nothing more to assert.
    if (outR.raw === inR.raw) return;

    const diskKeys = Object.keys(parsed.frontmatter);
    if (diskKeys.length === 0) {
      // The source had a block but parsed to {} (unresolvable alias / `<<` merge /
      // unparseable). The engine refuses + keep-raw preserves it verbatim (the
      // edit is dropped loudly via onFrontmatterRefused in the real gateway).
      expect(outR.raw, `${label}: poison/empty FM not preserved verbatim`).toBe(inR.raw);
      return;
    }

    const out2 = parseFm(outR.raw);
    expect(out2, `${label}: delta write produced unparseable FM`).not.toBeNull();
    if (!out2) return;
    for (const k of diskKeys) {
      if (k in delta.set || delta.unset.includes(k)) continue; // touched — checked below
      expect(out2[k], `${label}: untouched key "${k}" value changed`).toEqual(parsed.frontmatter[k]);
    }
    for (const k of Object.keys(delta.set)) {
      expect(valuesEqual(out2[k], delta.set[k]), `${label}: set key "${k}" wrong`).toBe(true);
    }
    for (const k of delta.unset) {
      if (k in parsed.frontmatter) expect(k in out2, `${label}: unset key "${k}" survived`).toBe(false);
    }
  }

  // Field-edit-style keys, DISJOINT from every HOSTILE_CORPUS key, so a generated
  // delta only ADDs/SETs keys the disk block lacks → the patch never refuses for
  // a touched anchored key → every disk key stays untouched + byte-preserved.
  // This is the realistic shape: a Kanban/Task field edit stamps
  // `completed`/`priority`/`due`, never the user's arbitrary keys.
  const FIELD_KEYS = ['completed', 'priority', 'due', 'status', 'assignee', 'reviewer'];
  const fieldValArb = fc.oneof(
    fc.constant(true),
    fc.constant(false),
    fc.constantFrom('high', 'low', 'done', 'todo'),
    fc.constant('2026-06-08'),
    fc.integer({ min: 0, max: 99 }),
  );
  const deltaArb = fc
    .record({
      corpus: fc.constantFrom(...HOSTILE_CORPUS.map((c) => c.md)),
      setKeys: fc.uniqueArray(fc.constantFrom(...FIELD_KEYS), { maxLength: 3 }),
      setVals: fc.array(fieldValArb, { maxLength: 3 }),
      unsetKeys: fc.uniqueArray(fc.constantFrom(...FIELD_KEYS), { maxLength: 2 }),
    })
    .map(({ corpus, setKeys, setVals, unsetKeys }) => {
      const set: Record<string, unknown> = {};
      setKeys.forEach((k, i) => {
        set[k] = setVals[i] ?? true;
      });
      const unset = unsetKeys.filter((k) => !(k in set)); // never both (delta invariant)
      return { diskMd: corpus, delta: { set, unset } as FrontmatterDelta };
    });

  it('a field-edit delta preserves every untouched disk key (value + scalar bytes) or refuses', () => {
    fc.assert(
      fc.property(deltaArb, ({ diskMd, delta }) => {
        assertSafeDeltaWrite(diskMd, delta, 'fuzz');
        // Disjoint delta keys never touch a disk key, so the patch path always
        // wins (no dump) → every untouched single-line scalar is byte-preserved.
        const inR = fmRegion(diskMd);
        if (!inR.has) return;
        const parsed = parseMarkdownFile(diskMd);
        if (Object.keys(parsed.frontmatter).length === 0) return; // poison — verbatim already asserted
        const outFm = fmRegion(applyDeltaLikeGateway(diskMd, delta)).raw.replace(/\r\n/g, '\n');
        const outLines = new Set(outFm.split('\n'));
        for (const k of Object.keys(parsed.frontmatter)) {
          const line = topLevelKeyLine(inR.raw, k);
          if (line === null) continue; // bare/nested/sequence — value compare already done
          expect(outLines.has(line), `fuzz: untouched key "${k}" line canonicalised ("${line}")`).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  // The untested shape the plan calls out: a delta-SET of a key whose disk value
  // is an unresolvable alias / `<<` merge. The engine refuses (toJS throws), the
  // assemble keeps the raw block verbatim, the edit is dropped — NEVER a partial
  // dump that erases the other keys.
  const POISON_ROWS: ReadonlyArray<{ label: string; md: string }> = [
    { label: 'unresolvable alias sibling', md: '---\ntitle: X\ntags: *missing\n---\nbody\n' },
    { label: 'missing-anchor << merge', md: '---\nwidget:\n  <<: *gone\ntitle: X\n---\nbody\n' },
  ];
  for (const { label, md } of POISON_ROWS) {
    it(`refuses + keeps the raw block verbatim on a delta-set: ${label}`, () => {
      // set a NEW key, and set the poison key itself — both must keep-raw.
      assertSafeDeltaWrite(md, { set: { priority: 'high' }, unset: [] }, label);
      assertSafeDeltaWrite(md, { set: { tags: ['x'] }, unset: [] }, `${label} (set poison key)`);
      expect(fmRegion(applyDeltaLikeGateway(md, { set: { priority: 'high' }, unset: [] })).raw).toBe(
        fmRegion(md).raw,
      );
    });
  }

  it('a delta that SETS an existing scalar keeps the other siblings byte-identical', () => {
    const md = '---\ntitle: Note\ncount: 3\nzip: 02134\nflag: true\n---\nbody\n';
    const out = applyDeltaLikeGateway(md, { set: { count: 4 }, unset: [] });
    const re = parseFm(fmRegion(out).raw);
    expect(re).not.toBeNull();
    expect(re!.count).toBe(4); // delta applied
    expect(re!.title).toBe('Note');
    const outLines = fmRegion(out).raw.split('\n');
    expect(outLines, 'untouched non-canonical scalar canonicalised').toContain('zip: 02134');
    expect(outLines).toContain('flag: true');
  });

  it('a delta that UNSETS an existing key drops only it and preserves siblings', () => {
    const md = '---\ntitle: Note\ncount: 3\nzip: 02134\n---\nbody\n';
    const out = applyDeltaLikeGateway(md, { set: {}, unset: ['count'] });
    const re = parseFm(fmRegion(out).raw);
    expect(re).not.toBeNull();
    expect('count' in re!, 'unset key survived').toBe(false);
    expect(re!.title).toBe('Note');
    expect(fmRegion(out).raw.split('\n'), 'untouched scalar canonicalised').toContain('zip: 02134');
  });

  it('an empty delta emits the disk frontmatter verbatim (comments + exotic scalars)', () => {
    const md = '---\n# kept\nzeta: 02134\nalpha: 1_000\n---\nold\n';
    const out = applyDeltaLikeGateway(md, { set: {}, unset: [] });
    expect(fmRegion(out).raw).toBe(fmRegion(md).raw);
    expect(fmRegion(out).body).toBe('old\n');
  });

  // 5.1 (Audit-16) — an on-disk `tags: []` must survive an UNRELATED field
  // delta byte-for-byte. Pre-fix the assemble's unconditional empty-tags drop
  // ran even on the delta path (where `fm` IS the fresh disk read), so the CST
  // engine saw `tags` as deleted and spliced the line out — the exact
  // "untouched key dropped" class this gate forbids.
  it('5.1 — an on-disk `tags: []` survives an unrelated field delta byte-for-byte', () => {
    const md = '---\ntitle: X\ntags: []\n---\nbody\n';
    const out = applyDeltaLikeGateway(md, { set: { completed: true }, unset: [] });
    const outRaw = fmRegion(out).raw;
    expect(outRaw.split('\n'), 'the `tags: []` line was dropped/reformatted').toContain('tags: []');
    const re = parseFm(outRaw)!;
    expect(re.tags, 'tags value changed').toEqual([]);
    expect(re.completed, 'delta not applied').toBe(true);
    expect(re.title).toBe('X');
  });

  // …while a file with NO baseline `tags` key keeps the cosmetic drop: a delta
  // that sets tags to [] on a file that never had the key does not write a
  // gratuitous `tags: []` line (the drop is gated on the baseline, not removed).
  it('5.1 — no baseline tags key ⇒ an empty-tags set still drops (cosmetic clean kept)', () => {
    const md = '---\ntitle: X\n---\nbody\n';
    const out = applyDeltaLikeGateway(md, { set: { tags: [] }, unset: [] });
    expect(fmRegion(out).raw).not.toContain('tags');
  });
});

/**
 * 5.4 (Audit-16) — NON-SCALAR mapping keys (`[a, b]: x`, `{k: 1}: x`). The
 * `yaml` package parses them with zero errors but `toJS()` STRINGIFIES the key
 * ("[ a, b ]") because a plain JS object can't hold it — so the object view is
 * not faithful to the source. Pre-fix the engine passed the item through
 * WITHOUT recording it in `presentKeys`, then the added-keys pass appended the
 * stringified twin as a NEW string key: one unrelated edit grew a silent
 * semantic duplicate (`[a, b]: x` + `"[ a, b ]": x`). The engine now refuses,
 * and the assemble routes the refusal to keep-raw (NOT the dump fallback, which
 * would rewrite the key as its quoted string twin — a semantic change).
 */
describe('frontmatter non-scalar mapping keys — engine refuses, file byte-identical (Audit-16 5.4)', () => {
  const CASES: ReadonlyArray<{ label: string; src: string }> = [
    { label: 'flow-seq key', src: '[a, b]: x\ntitle: t' },
    { label: 'flow-map key', src: '{k: 1}: x\ntitle: t' },
  ];

  for (const { label, src } of CASES) {
    it(`the engine refuses an unrelated edit on: ${label}`, () => {
      const cur = parseFm(src);
      expect(cur, `${label}: corpus source must parse (stringified-key view)`).not.toBeNull();
      // Pre-fix this returned a string carrying BOTH the original item and the
      // appended stringified twin; post-fix it refuses.
      expect(patchFrontmatterSourceCst(src, { ...cur!, title: 'u' })).toBeNull();
    });

    it(`an unrelated metadata edit keeps the whole file byte-identical: ${label}`, () => {
      const md = `---\n${src}\n---\nbody\n`;
      const parsed = parseMarkdownFile(md);
      let refused = false;
      const out = assembleMarkdownFile({ ...parsed.frontmatter, title: 'u' }, parsed.body, {
        rawFrontmatter: parsed.rawFrontmatter,
        originalFrontmatter: parsed.rawFrontmatter,
        frontmatterDirty: true,
        onFrontmatterRefused: () => {
          refused = true;
        },
      });
      // Keep-raw, not dump: the dump would emit the quoted string twin and drop
      // the original collection-keyed line.
      expect(out, `${label}: file must be byte-identical`).toBe(md);
      expect(refused, `${label}: the dropped edit must surface loudly`).toBe(true);
    });
  }
});
