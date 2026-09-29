import { describe, it, expect } from 'vitest';
import { roundTripChanges, lineOfRoundTripChange } from '@renderer/lib/editor/markdownSync';
import { describeChange, locateChanges } from '@renderer/lib/editor/lossyChanges';

describe('roundTripChanges', () => {
  it('is empty when nothing differs (in the check\'s normal form)', () => {
    expect(roundTripChanges('* a\n* b', '- a\n- b')).toEqual([]);
  });

  it('pairs the lines of the one region that differs', () => {
    expect(roundTripChanges('Top\n\n[TODO] x\n\nEnd', 'Top\n\n\\[TODO\\] x\n\nEnd')).toEqual([
      { original: '[TODO] x', filo: '\\[TODO\\] x' },
    ]);
  });

  it('names a dropped line and an added line', () => {
    expect(roundTripChanges('a\n<!-- note -->\nb', 'a\nb')).toEqual([{ original: '<!-- note -->', filo: '' }]);
    expect(roundTripChanges('a', 'a\n\nextra')).toEqual([{ original: '', filo: 'extra' }]);
  });

  it('lists at most three', () => {
    const original = ['1', '2', '3', '4', '5'].map((n) => `[${n}]`).join('\n\n');
    const filo = ['1', '2', '3', '4', '5'].map((n) => `\\[${n}\\]`).join('\n\n');
    expect(roundTripChanges(original, filo)).toHaveLength(3);
  });
});

describe('locating and describing a change', () => {
  const file = '---\ntitle: T\n---\nIntro\n\n* [TODO] x\n';

  it('finds the line in the whole file, after the frontmatter, in normal form', () => {
    expect(lineOfRoundTripChange(file, '- [TODO] x', 4)).toBe(6);
    const [c] = locateChanges(file, [{ original: '- [TODO] x', filo: '- \\[TODO\\] x' }]);
    expect(c.line).toBe(6);
    expect(describeChange(c)).toBe('Line 6 would change from “- [TODO] x” to “- \\[TODO\\] x”');
  });

  it('a line it can\'t find is "a line"; long lines are shortened', () => {
    const [c] = locateChanges(file, [{ original: 'x'.repeat(80), filo: 'y' }]);
    expect(c.line).toBe(0);
    expect(describeChange(c)).toBe(`A line would change from “${'x'.repeat(59)}…” to “y”`);
  });

  it('a dropped line and an added one', () => {
    expect(describeChange({ original: '<!-- c -->', filo: '', line: 3 })).toBe('Line 3 (“<!-- c -->”) would be dropped');
    expect(describeChange({ original: '', filo: 'new', line: 0 })).toBe('Saving would add “new”');
  });
});
