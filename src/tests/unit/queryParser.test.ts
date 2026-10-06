import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  isEmptyQuery,
  type ParsedQuery,
} from '@renderer/lib/search/queryParser';

function opsOnly(q: ParsedQuery): ParsedQuery['operators'] {
  return q.operators;
}

describe('parseQuery — empty / plain text', () => {
  it('returns an empty parse for the empty string', () => {
    const q = parseQuery('');
    expect(isEmptyQuery(q)).toBe(true);
    expect(q.raw).toBe('');
  });

  it('searches whitespace-only input as typed', () => {
    const q = parseQuery('   ');
    expect(isEmptyQuery(q)).toBe(false);
    expect(q.freeText).toBe('   ');
    expect(q.raw).toBe('   ');
  });

  it('puts plain-text words into freeText', () => {
    const q = parseQuery('hello world');
    expect(q.freeText).toBe('hello world');
    expect(q.operators).toEqual([]);
    expect(q.regex).toBeNull();
  });

  it('with an operator, preserves quoted strings with whitespace', () => {
    const q = parseQuery('tag:x "hello world" plain');
    expect(q.freeText).toBe('hello world plain');
  });
});

describe('parseQuery — text with no operator is searched as typed', () => {
  it('keeps leading, trailing and repeated spaces', () => {
    expect(parseQuery(' - ').freeText).toBe(' - ');
    expect(parseQuery('a  b').freeText).toBe('a  b');
    expect(parseQuery('the end. ').freeText).toBe('the end. ');
  });

  it('keeps quotes as typed', () => {
    expect(parseQuery('"hello world" plain').freeText).toBe('"hello world" plain');
    expect(parseQuery('say "hi"').freeText).toBe('say "hi"');
  });

  it('a misspelled operator is text, so the query is kept as typed', () => {
    expect(parseQuery('has:wibble  x').freeText).toBe('has:wibble  x');
  });

  it('with an operator, the rest is tokenised as before', () => {
    const q = parseQuery('tag:x  foo   bar ');
    expect(q.operators).toEqual([{ kind: 'tag', value: 'x' }]);
    expect(q.freeText).toBe('foo bar');
    expect(parseQuery('tag:x " - "').freeText).toBe(' - ');
  });

  it('a /regex/ is still a regex, with spaces around it', () => {
    const q = parseQuery(' / - / ');
    expect(q.regex?.source).toBe(' - ');
    expect(q.freeText).toBe('');
  });
});

describe('parseQuery — tag operator', () => {
  it('parses tag:#name and strips the leading hash', () => {
    const q = parseQuery('tag:#urgent');
    expect(opsOnly(q)).toEqual([{ kind: 'tag', value: 'urgent' }]);
  });

  it('parses tag:name without the hash', () => {
    const q = parseQuery('tag:work');
    expect(opsOnly(q)).toEqual([{ kind: 'tag', value: 'work' }]);
  });

  it('supports escaped colons in tag values', () => {
    const q = parseQuery('tag:#has\\:colon');
    expect(opsOnly(q)).toEqual([{ kind: 'tag', value: 'has:colon' }]);
  });
});

describe('parseQuery — board operator', () => {
  it('captures the board name verbatim', () => {
    const q = parseQuery('board:Planning');
    expect(opsOnly(q)).toEqual([{ kind: 'board', value: 'Planning' }]);
  });

  it('supports quoted board names with whitespace', () => {
    const q = parseQuery('board:"Weekly Planning"');
    expect(opsOnly(q)).toEqual([{ kind: 'board', value: 'Weekly Planning' }]);
  });
});

describe('parseQuery — has operator', () => {
  it('recognises has:connections', () => {
    const q = parseQuery('has:connections');
    expect(opsOnly(q)).toEqual([{ kind: 'has-connections' }]);
  });

  it('degrades unknown has: values to free text', () => {
    const q = parseQuery('has:wibble');
    expect(opsOnly(q)).toEqual([]);
    expect(q.freeText).toBe('has:wibble');
  });
});

describe('parseQuery — property operator', () => {
  it('parses property:key=value', () => {
    const q = parseQuery('property:status=active');
    expect(opsOnly(q)).toEqual([{ kind: 'property', key: 'status', value: 'active' }]);
  });

  it('allows colons in property values', () => {
    const q = parseQuery('property:status=in:progress');
    expect(opsOnly(q)).toEqual([{ kind: 'property', key: 'status', value: 'in:progress' }]);
  });

  it('rejects malformed property syntax (missing =)', () => {
    const q = parseQuery('property:statusactive');
    expect(opsOnly(q)).toEqual([]);
    expect(q.freeText).toBe('property:statusactive');
  });
});

describe('parseQuery — type operator', () => {
  it('parses type:image', () => {
    const q = parseQuery('type:image');
    expect(opsOnly(q)).toEqual([{ kind: 'type', value: 'image' }]);
  });

  it('rejects unknown tile types', () => {
    const q = parseQuery('type:nonsense');
    expect(opsOnly(q)).toEqual([]);
    expect(q.freeText).toBe('type:nonsense');
  });
});

describe('parseQuery — regex literal', () => {
  it('detects /pattern/ and compiles a global-by-default regex', () => {
    const q = parseQuery('/hello/');
    expect(q.regex).not.toBeNull();
    expect(q.regex!.flags).toContain('g');
    expect('hello world'.match(q.regex!)).toBeTruthy();
  });

  it('preserves user-supplied flags', () => {
    const q = parseQuery('/HELLO/i');
    expect(q.regex).not.toBeNull();
    expect(q.regex!.flags).toContain('i');
    expect('hello'.match(q.regex!)).toBeTruthy();
  });

  it('degrades invalid regex to free text', () => {
    const q = parseQuery('/[unclosed/');
    expect(q.regex).toBeNull();
    expect(q.freeText).toBe('/[unclosed/');
  });

  it('does not parse regex when mixed with operators (full-input only)', () => {
    const q = parseQuery('tag:work /hello/');
    expect(q.regex).toBeNull();
    expect(q.operators).toHaveLength(1);
    expect(q.freeText).toBe('/hello/');
  });
});

describe('parseQuery — multi-operator queries', () => {
  it('combines tag + property + board', () => {
    const q = parseQuery('tag:#urgent property:status=active board:Planning');
    expect(opsOnly(q)).toEqual([
      { kind: 'tag', value: 'urgent' },
      { kind: 'property', key: 'status', value: 'active' },
      { kind: 'board', value: 'Planning' },
    ]);
    expect(q.freeText).toBe('');
  });

  it('mixes operators with free text', () => {
    const q = parseQuery('tag:urgent meeting notes');
    expect(opsOnly(q)).toEqual([{ kind: 'tag', value: 'urgent' }]);
    expect(q.freeText).toBe('meeting notes');
  });
});

describe('parseQuery — plain text preserves Windows paths', () => {
  it('keeps a path with no operator exactly as typed, backslashes included', () => {
    // `C:` is no operator, so the whole query is the text to find; the
    // tokeniser's colon escape never applies to it.
    expect(parseQuery('C:\\foo\\bar').freeText).toBe('C:\\foo\\bar');
  });

  // A backslash is an escape only before a colon in an operator value: a
  // filter in the query used to turn `C:\foo` into `C:foo`, quoted or not.
  it('keeps the backslashes of a path searched with a filter', () => {
    expect(parseQuery('tag:x C:\\foo\\bar').freeText).toBe('C:\\foo\\bar');
    expect(parseQuery('tag:x "C:\\My Notes\\foo"').freeText).toBe('C:\\My Notes\\foo');
  });

  it('keeps a backslash inside an operator value unless a colon follows it', () => {
    expect(opsOnly(parseQuery('property:path=C:\\notes'))).toEqual([
      { kind: 'property', key: 'path', value: 'C:\\notes' },
    ]);
    expect(opsOnly(parseQuery('property:status=in\\:progress'))).toEqual([
      { kind: 'property', key: 'status', value: 'in:progress' },
    ]);
  });
});
