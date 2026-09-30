/**
 * The Kanban checklist badge counts the note's task items only: a `[x]` in a
 * link, in inline code, in a fenced code block or mid-line is text.
 */
import { describe, it, expect } from 'vitest';
import { checklistProgress } from '@renderer/lib/kanban/checklistProgress';

describe('checklistProgress', () => {
  it('counts checked and open task items, any bullet, numbered, nested or quoted', () => {
    const body = [
      '- [x] done',
      '- [ ] open',
      '  * [X] nested, capital X',
      '1. [ ] numbered',
      '> - [x] quoted',
      '- [ ]',
    ].join('\n');
    expect(checklistProgress(body)).toEqual({ checked: 3, total: 6 });
  });

  it('ignores [x] and [ ] that are not task items', () => {
    const body = [
      'Press [x] to close, or [ ] to keep.',
      'A link [x](https://example.com) and `- [x] code`',
      '- plain item with [x] inside',
      '- [x]no space is not a task',
      '```',
      '- [x] in a fence',
      '```',
      '~~~~',
      '- [ ] in a tilde fence',
      '~~~',
      '- [ ] still fenced (a shorter run does not close it)',
      '~~~~',
      '- [x] the only task',
    ].join('\n');
    expect(checklistProgress(body)).toEqual({ checked: 1, total: 1 });
  });

  it('is null for a note with no task items, and reads CRLF', () => {
    expect(checklistProgress('Just [x] text\n')).toBeNull();
    expect(checklistProgress('- [ ] a\r\n- [x] b\r\n')).toEqual({ checked: 1, total: 2 });
  });
});
