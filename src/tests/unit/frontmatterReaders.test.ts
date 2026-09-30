import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { FIELD_READERS } from '@renderer/lib/tasks/frontmatterReaders';

/**
 * `completed:` as other apps and hand edits write it. YAML 1.2 (the `yaml`
 * package) reads `yes` / `on` / a quoted `"true"` as strings; each means done.
 */
describe('FIELD_READERS.completed', () => {
  const done = (yamlText: string): boolean => FIELD_READERS.completed(parse(yamlText) as Record<string, unknown>);

  it('reads a YAML boolean', () => {
    expect(done('completed: true')).toBe(true);
    expect(done('completed: false')).toBe(false);
  });

  it('reads yes / on / a quoted "true" as done, in any case', () => {
    expect(done('completed: yes')).toBe(true);
    expect(done('completed: Yes')).toBe(true);
    expect(done('completed: on')).toBe(true);
    expect(done('completed: "true"')).toBe(true);
  });

  it('reads no / off / anything else as not done', () => {
    expect(done('completed: no')).toBe(false);
    expect(done('completed: off')).toBe(false);
    expect(done('completed: "false"')).toBe(false);
    expect(done('completed: 1')).toBe(false);
    expect(done('completed:')).toBe(false);
    expect(done('title: x')).toBe(false);
  });
});
