import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import yaml from 'js-yaml';
import {
  addTagToMarkdown,
  removeTagFromMarkdown,
  rewriteTagInMarkdown,
} from '@renderer/lib/vault/tagRewriter';
import { parseMarkdownFile, assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';

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
 * Wired into CI as its own gate via `scripts/check-frontmatter-invariant.mjs`
 * (`npm run ci:frontmatter-invariant`) so it can't be dropped from `ci:verify`.
 */

interface FmRegion {
  raw: string;
  body: string;
  has: boolean;
}

function fmRegion(md: string): FmRegion {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  return m ? { raw: m[1], body: m[2] ?? '', has: true } : { raw: '', body: md, has: false };
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
  { label: 'duplicate key (unparseable)', md: '---\ntitle: X\ntitle: Y\ntags:\n  - foo\n---\nbody\n' },
  { label: 'tab indent (unparseable)', md: '---\ntitle: X\n\tbad: tab\ntags:\n  - foo\n---\nbody\n' },
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
