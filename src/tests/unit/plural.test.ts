import { describe, it, expect } from 'vitest';
import { plural } from '../../renderer/lib/utils/plural';

describe('plural', () => {
  it('says a count with its word, never "(s)"', () => {
    expect(plural(1, 'tile')).toBe('1 tile');
    expect(plural(0, 'tile')).toBe('0 tiles');
    expect(plural(3, 'tile')).toBe('3 tiles');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
    expect(plural(1, 'change is', 'changes are')).toBe('1 change is');
  });
});
