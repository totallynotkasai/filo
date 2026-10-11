import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseDocument } from 'yaml';
import { valuesEqual } from '@renderer/lib/vault/frontmatterEngine';
import { patchFrontmatterSourceCst } from '@renderer/lib/vault/frontmatterCstModel';

/**
 * The CST-engine corpus contract (formerly the DIFFERENTIAL harness).
 *
 * While the legacy byte-splice engine still existed, this file ran the whole
 * object-patch corpus + a fuzzer through BOTH engines and asserted they agreed
 * byte-for-byte (the safety net that justified routing production through the CST
 * engine). With the legacy engine deleted, the differential comparison is
 * gone — but its INDEPENDENT contract assertions are kept here as a permanent,
 * single-engine regression net: for every corpus shape and every fuzzed shape,
 * `patchFrontmatterSourceCst` must either refuse (`null`, caller dumps) or emit a
 * block that re-parses, carries the correct value for every key, drops exactly
 * the deleted keys, and keeps every UNTOUCHED single-line scalar's source line
 * BYTE-identical (the source-canonicalisation surface).
 */

/**
 * Parse a fenceless FM block the way the READ path does (`markdownSync.parseMarkdownFile`
 * → the `yaml` package's `parseDocument().toJS()`, the SAME parser the CST engine
 * compares against). This is what makes the harness faithful: the `nextObj` it
 * builds carries the value types the engine sees, so an untouched `1_000` (a
 * STRING here, not the number js-yaml CORE would give) is recognised as unchanged
 * and spliced verbatim — exactly as production does. Returns `null` on any parse
 * error / non-mapping root (the read path's fail-safe).
 */
function parseFm(block: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(block, { logLevel: 'error' });
    if (doc.errors.length > 0) return null;
    const o = doc.toJS();
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The single top-level `key: value` SOURCE LINE for `key` when it is an
 * unambiguous single-line scalar (so its bytes can be asserted preserved), else
 * `null`. Mirrors the helper in `frontmatterInvariant.test.ts`.
 */
function topLevelKeyLine(source: string, key: string): string | null {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
  const idxs: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(l)) idxs.push(i);
  });
  if (idxs.length !== 1) return null;
  const i = idxs[0];
  const line = lines[i];
  if (/:\s*(#.*)?$/.test(line)) return null; // bare key (empty value / block parent)
  const next = lines[i + 1] ?? '';
  if (/^\s+\S/.test(next) || /^\s*-\s/.test(next)) return null; // nested map / sequence
  return line;
}

/** The engine's output held to the full contract (a `null` refusal is always safe). */
function assertEngineSafe(source: string, nextObj: Record<string, unknown>, label: string): void {
  const out = patchFrontmatterSourceCst(source, nextObj);
  if (out === null) return; // refuse → caller falls back to a lossless full dump
  const current = parseFm(source) ?? {};

  const reObj = parseFm(out);
  expect(reObj, `${label}: output did not re-parse into a mapping`).not.toBeNull();
  if (!reObj) return;

  const expectedKeys = Object.keys(nextObj).filter((k) => nextObj[k] !== undefined);
  for (const k of expectedKeys) {
    expect(valuesEqual(reObj[k], nextObj[k]), `${label}: wrong value for key "${k}"`).toBe(true);
  }
  for (const k of Object.keys(current)) {
    if (!expectedKeys.includes(k)) {
      expect(k in reObj, `${label}: deleted key "${k}" survived`).toBe(false);
    }
  }
  for (const k of Object.keys(reObj)) {
    expect(expectedKeys.includes(k), `${label}: unexpected key "${k}" appeared`).toBe(true);
  }

  const outLines = new Set(out.split('\n'));
  for (const k of expectedKeys) {
    if (!(k in current)) continue; // an added key was never "untouched"
    if (!valuesEqual(current[k], nextObj[k])) continue; // changed key
    const line = topLevelKeyLine(source, k);
    if (line === null) continue;
    expect(outLines.has(line), `${label}: untouched key "${k}" line canonicalised ("${line}")`).toBe(true);
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
  { name: 'add scalar key', run: (cur) => ({ ...cur, addedKey: 'added value' }) },
  { name: 'add list key', run: (cur) => ({ ...cur, addedList: ['x', '@home'] }) },
  { name: 'set tags->list', run: (cur) => ({ ...cur, tags: ['draft', 'final'] }) },
  { name: 'set tags->scalar', run: (cur) => ({ ...cur, tags: 'solo' }) },
];

// Fenceless FM SOURCE blocks. Covers the legacy corpus shapes PLUS the
// single-parser gap cases (anchored untouched sibling, folded `>` untouched
// sibling, nested collections, CRLF, quoted/numeric/bool siblings).
const ENGINE_CORPUS: ReadonlyArray<{ label: string; src: string }> = [
  { label: 'leading comment', src: '# leading note\ntitle: Note\ncount: 3' },
  { label: 'standalone comment between keys', src: 'title: Note\n# section break\ncount: 3' },
  { label: 'trailing comment block', src: 'title: Note\ncount: 3\n# trailing note' },
  { label: 'inline trailing comments', src: 'title: Note   # inline a\ncount: 3   # inline b' },
  { label: 'non-canonical scalar siblings', src: 'title: Note\nzip: 02134\nthousands: 1_000\nmask: 0xFF' },
  { label: 'quoted scalars', src: 'title: Note\ndq: "keep me"\nsq: \'literal\'' },
  { label: 'multi-key plain', src: 'a: 1\nb: two\nc: true\nd: 4.5' },
  { label: 'single key', src: 'only: value' },
  { label: 'no trailing newline', src: 'title: Note\ncount: 3\nzip: 02134' },
  { label: 'trailing blank line', src: 'title: Note\ncount: 3\n' },
  { label: 'block tags', src: 'tags:\n  - alpha\n  - beta\nstatus: open' },
  { label: 'flow tags', src: 'title: X\ntags: [foo, bar]' },
  { label: 'scalar tags', src: 'title: X\ntags: foo, bar' },
  { label: 'quoted special tag (flow)', src: 'title: X\ntags: ["@home", foo]' },
  { label: 'numeric/bool siblings', src: 'count: 3\nflag: true\ntags:\n  - foo' },
  { label: 'unquoted date', src: 'created: 2025-01-15\ntitle: Note' },
  { label: 'nested map', src: 'title: Note\nmeta:\n  author: me   # who\n  year: 2020' },
  { label: 'folded > untouched sibling', src: 'summary: >\n  line one\n  line two\ntitle: Note\ncount: 3' },
  { label: 'anchored untouched sibling', src: 'base: &b 5\nthreshold: *b\ntitle: Note' },
  { label: 'merge key untouched sibling', src: 'defaults: &d\n  color: red\nwidget:\n  <<: *d\n  size: big\ntitle: Note' },
  { label: 'CRLF block', src: 'title: Note\r\ncount: 3\r\nzip: 02134\r\n' },
  { label: 'bare key middle', src: 'title: Note\naliases:\ncount: 3' },
];

describe('frontmatter CST engine — corpus contract (single engine)', () => {
  for (const { label, src } of ENGINE_CORPUS) {
    const current = parseFm(src);
    if (!current || Object.keys(current).length === 0) continue;
    it(`satisfies the contract on: ${label}`, () => {
      for (const op of OBJECT_OPS) {
        assertEngineSafe(src, op.run(current), `${op.name} / ${label}`);
      }
    });
  }

  // The added-key-after-a-trailing-blank-line case (an append wrinkle).
  it('add key after a trailing blank line', () => {
    const src = 'title: Note\ncount: 3\n';
    assertEngineSafe(src, { title: 'Note', count: 3, tags: ['x'] }, 'add-after-blank');
  });
});

/**
 * The property-based contract. Generates random frontmatter on RAW non-canonical
 * source lines (so untouched siblings are NOT already canonical — the
 * byte-preservation surface at risk), then applies a random set / delete /
 * add op and holds the engine to the contract across thousands of shapes.
 */
describe('frontmatter CST engine — fuzz set/delete/add', () => {
  const SCALAR_SOURCES = [
    'X', 'hello world', '42', '-7', '0', '3.14', 'true', 'false', '02134', '0306406152',
    '1_000', '0xFF', '0xFF00FF', '0o17', '6.022e23', '007', '+5', '1:30', '"double quoted"', "'single quoted'",
  ];

  type FieldKind = 'scalar' | 'bare' | 'nested';

  const fieldArb = fc.record({
    kind: fc.constantFrom<FieldKind>('scalar', 'scalar', 'scalar', 'bare', 'nested'),
    scalar: fc.constantFrom(...SCALAR_SOURCES),
    innerA: fc.constantFrom(...SCALAR_SOURCES),
    innerB: fc.constantFrom(...SCALAR_SOURCES),
    comment: fc.boolean(),
  });

  function fieldLines(
    i: number,
    f: { kind: FieldKind; scalar: string; innerA: string; innerB: string; comment: boolean },
  ): string[] {
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
      op: fc.constantFrom(0, 1, 2),
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

  it('satisfies the contract across thousands of generated shapes', () => {
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
          const k = keys[pick % keys.length];
          nextObj = { ...current, [k]: newVal };
        }
        assertEngineSafe(source, nextObj, `op=${op} n=${n}`);
      }),
      { numRuns: 400 },
    );
  });
});
