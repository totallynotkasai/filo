import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { patchFrontmatterSourceCst } from '@renderer/lib/vault/frontmatterCstModel';

/**
 * Focused unit tests for the CST-operations engine, in addition to the
 * corpus-wide `frontmatterEngineDifferential.test.ts` (which proves it equals
 * the legacy engine). These pin the engine's sharp edges in their own right:
 *
 *  - the ADD-item newline wrinkle across trailing shapes (the proven hazard:
 *    appending after a value with no trailing newline must NOT concatenate onto
 *    the previous line — `count: 3addedKey`);
 *  - the nested-collection / type-change swap;
 *  - comment survival (leading / standalone / trailing / inline) on an unrelated
 *    edit, and that a DELETED key's documenting comment drops with it rather
 *    than relocating onto a survivor;
 *  - the bare-empty-key set re-parsing correctly;
 *  - the anchor/alias refusal boundary.
 */

function core(block: string): Record<string, unknown> | null {
  const o = yaml.load(block, { schema: yaml.CORE_SCHEMA });
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
}

describe('patchFrontmatterSourceCst — add-item newline wrinkle across trailing shapes', () => {
  // A freshly-added key always appends last. Whatever the trailing shape of the
  // source, the append must keep the prior key on its own line and re-parse.
  const cases: ReadonlyArray<{ label: string; src: string }> = [
    { label: 'trailing newline', src: 'title: Note\ncount: 3\n' },
    { label: 'NO trailing newline', src: 'title: Note\ncount: 3' },
    { label: 'trailing blank line', src: 'title: Note\ncount: 3\n\n' },
    { label: 'trailing comment block', src: 'title: Note\ncount: 3\n# trailing note' },
    { label: 'single key, no newline', src: 'only: value' },
  ];

  for (const { label, src } of cases) {
    it(`appends a scalar key without concatenating: ${label}`, () => {
      const current = core(src)!;
      const out = patchFrontmatterSourceCst(src, { ...current, added: 'new' });
      expect(out, `${label}: refused`).not.toBeNull();
      // The proven hazard: the previous value must not run into the new key.
      expect(out, `${label}: concatenated onto the previous line`).not.toMatch(/\S(added):/);
      const re = core(out!);
      expect(re, `${label}: did not re-parse`).not.toBeNull();
      expect(re!.added).toBe('new');
      for (const k of Object.keys(current)) expect(re![k]).toEqual(current[k]);
    });

    it(`appends a LIST key without concatenating: ${label}`, () => {
      const current = core(src)!;
      const out = patchFrontmatterSourceCst(src, { ...current, tags: ['x', '@home'] });
      expect(out).not.toBeNull();
      const re = core(out!);
      expect(re).not.toBeNull();
      expect(re!.tags).toEqual(['x', '@home']);
      for (const k of Object.keys(current)) expect(re![k]).toEqual(current[k]);
    });
  }

  it('grows a mapping onto an empty source', () => {
    const out = patchFrontmatterSourceCst('', { title: 'New', tags: ['a'] });
    expect(out).not.toBeNull();
    expect(core(out!)).toEqual({ title: 'New', tags: ['a'] });
  });

  it('grows a mapping onto a comment-only source, preserving the comment', () => {
    const out = patchFrontmatterSourceCst('# just a note\n', { title: 'New' });
    expect(out).not.toBeNull();
    expect(out, 'leading comment dropped').toContain('# just a note');
    expect(core(out!)).toEqual({ title: 'New' });
  });
});

describe('patchFrontmatterSourceCst — nested-collection / type-change swap', () => {
  it('swaps a nested map value, keeping untouched siblings byte-for-byte', () => {
    const src = 'title: Note\nzip: 02134\nmeta:\n  author: me\n  year: 2020';
    const current = core(src)!;
    const out = patchFrontmatterSourceCst(src, { ...current, meta: { author: 'you', year: 2020 } });
    expect(out).not.toBeNull();
    expect(out!.split('\n'), 'untouched non-canonical scalar canonicalised').toContain('zip: 02134');
    const re = core(out!);
    expect((re!.meta as Record<string, unknown>).author).toBe('you');
    expect(re!.title).toBe('Note');
  });

  it('changes a scalar to a list (type change) and re-parses', () => {
    const src = 'title: Note\ntags: draft';
    const out = patchFrontmatterSourceCst(src, { title: 'Note', tags: ['draft', 'final'] });
    expect(out).not.toBeNull();
    const re = core(out!);
    expect(re!.tags).toEqual(['draft', 'final']);
    expect(re!.title).toBe('Note');
  });

  it('changes a list to a scalar (type change) and re-parses', () => {
    const src = 'tags:\n  - a\n  - b\ntitle: Note';
    const current = core(src)!;
    const out = patchFrontmatterSourceCst(src, { ...current, tags: 'solo' });
    expect(out).not.toBeNull();
    const re = core(out!);
    expect(re!.tags).toBe('solo');
    expect(re!.title).toBe('Note');
  });
});

describe('patchFrontmatterSourceCst — comment survival', () => {
  it('keeps a LEADING comment on a first-key edit', () => {
    const out = patchFrontmatterSourceCst('# leading note\ntitle: Note\ncount: 3', {
      title: 'Renamed',
      count: 3,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('# leading note');
    expect(out).toContain('title: Renamed');
  });

  it('keeps a STANDALONE comment between keys on a sibling edit', () => {
    const out = patchFrontmatterSourceCst('title: Note\n# section break\ncount: 3', {
      title: 'Note',
      count: 4,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('# section break');
  });

  it('keeps a TRAILING comment block on an edit', () => {
    const out = patchFrontmatterSourceCst('title: Note\ncount: 3\n# trailing note', {
      title: 'Renamed',
      count: 3,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('# trailing note');
  });

  it('keeps an INLINE trailing comment on a changed scalar (value-only splice)', () => {
    const out = patchFrontmatterSourceCst('title: Old   # the title\nzip: 02134', {
      title: 'New',
      zip: 2134,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('# the title');
    expect(out).toContain('title: New');
    expect(out, 'untouched scalar bytes canonicalised').toContain('zip: 02134');
  });

  it('drops a deleted key’s documenting comment instead of relocating it onto the next key', () => {
    // `# doc for count` documents `count`; deleting `count` must remove the
    // comment with it, not migrate it onto `status` (an unrelated surviving
    // field). Structural keys are untouched and re-parse.
    const out = patchFrontmatterSourceCst('title: Note\n# doc for count\ncount: 3\nstatus: open', {
      title: 'Note',
      status: 'open',
    });
    expect(out).not.toBeNull();
    expect(out, 'deleted key’s comment migrated to a surviving key').not.toContain('# doc for count');
    const re = core(out!);
    expect('count' in re!).toBe(false);
    expect(re!.status).toBe('open');
  });

  it('keeps the blank-line gap above a deleted commented key while dropping the comment', () => {
    // The blank line separating `title` from foo's documented section is
    // structural spacing — it survives — but the comment glued to the deleted
    // `foo` does not relocate onto `baz`.
    const out = patchFrontmatterSourceCst('title: Note\n\n# doc for foo\nfoo: bar\nbaz: qux', {
      title: 'Note',
      baz: 'qux',
    });
    expect(out).not.toBeNull();
    expect(out, 'comment migrated to a survivor').not.toContain('# doc for foo');
    expect(out, 'blank-line gap collapsed').toContain('title: Note\n\nbaz: qux');
    const re = core(out!);
    expect('foo' in re!).toBe(false);
    expect(re!.baz).toBe('qux');
  });
});

describe('patchFrontmatterSourceCst — bare-empty-key set re-parses', () => {
  const BARE_KEYS = ['aliases', 'tags', 'cssclasses'] as const;
  type Position = 'first' | 'middle' | 'last';
  const SIBLING_BEFORE = 'title: Note';
  const SIBLING_AFTER = 'count: 3';

  for (const bareKey of BARE_KEYS) {
    for (const position of ['first', 'middle', 'last'] as Position[]) {
      it(`set value on bare "${bareKey}" @${position} re-parses & keeps siblings`, () => {
        const bareLine = `${bareKey}:`;
        const lines =
          position === 'first'
            ? [bareLine, SIBLING_BEFORE, SIBLING_AFTER]
            : position === 'middle'
              ? [SIBLING_BEFORE, bareLine, SIBLING_AFTER]
              : [SIBLING_BEFORE, SIBLING_AFTER, bareLine];
        const src = lines.join('\n');
        const current = core(src)!;
        const out = patchFrontmatterSourceCst(src, { ...current, [bareKey]: 'home' });
        expect(out, 'engine refused').not.toBeNull();
        const re = core(out!);
        expect(re, 'output did not re-parse (bare-key collapse)').not.toBeNull();
        expect(re![bareKey], 'bare-key value wrong').toBe('home');
        expect(re!.title).toBe('Note');
        expect(re!.count).toBe(3);
        // The bare-key corruption emitted `aliases:home` (no space) — assert the fix.
        expect(out, 'bare-key value-set concatenated without a space').not.toMatch(
          new RegExp(`${bareKey}:\\S`),
        );
      });
    }
  }
});

describe('patchFrontmatterSourceCst — anchors / aliases', () => {
  const SRC = 'base: &b 5\nthreshold: *b\ntitle: Note';

  it('refuses when the CHANGED key carries an anchor', () => {
    const current = core(SRC)!;
    expect(patchFrontmatterSourceCst(SRC, { ...current, base: 10 })).toBeNull();
  });

  it('refuses when the CHANGED key is itself an alias', () => {
    const current = core(SRC)!;
    expect(patchFrontmatterSourceCst(SRC, { ...current, threshold: 99 })).toBeNull();
  });

  it('refuses when an anchored key is DELETED (would dangle its alias)', () => {
    const current = core(SRC)!;
    const next = { ...current };
    delete next.base;
    expect(patchFrontmatterSourceCst(SRC, next)).toBeNull();
  });

  it('SPLICES an edit to an unrelated key, preserving anchors verbatim', () => {
    const current = core(SRC)!;
    const out = patchFrontmatterSourceCst(SRC, { ...current, title: 'Renamed' });
    expect(out, 'over-refused a safe edit').not.toBeNull();
    expect(out).toContain('&b 5');
    expect(out).toContain('threshold: *b');
    expect(out).toContain('title: Renamed');
  });

  it('preserves a nested merge-key alias when an unrelated key is edited', () => {
    const src = 'defaults: &d\n  color: red\nwidget:\n  <<: *d\n  size: big\ntitle: Note';
    const current = core(src)!;
    const out = patchFrontmatterSourceCst(src, { ...current, title: 'Renamed' });
    expect(out, 'over-refused a doc whose only anchor sits in untouched keys').not.toBeNull();
    expect(out).toContain('<<: *d');
    expect(out).toContain('&d');
  });
});

describe('patchFrontmatterSourceCst — refusal parity (fails closed)', () => {
  it('refuses a top-level scalar or sequence', () => {
    expect(patchFrontmatterSourceCst('just a string', { a: 1 })).toBeNull();
    expect(patchFrontmatterSourceCst('- a\n- b', { a: 1 })).toBeNull();
  });

  it('refuses an unparseable block (duplicate keys / bad indent)', () => {
    expect(patchFrontmatterSourceCst('title: a\ntitle: b', { title: 'c' })).toBeNull();
    expect(patchFrontmatterSourceCst('a:\n\tb: 1', { a: 1 })).toBeNull();
  });

  it('refuses a flow-mapping root', () => {
    expect(patchFrontmatterSourceCst('{title: X, count: 1}', { title: 'Y', count: 1 })).toBeNull();
  });
});
