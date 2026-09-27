import { describe, it, expect } from 'vitest';
import { assembleMarkdownFile, parseMarkdownFile } from '../../renderer/lib/editor/markdownSync';
import { bodyWithoutFenceLookalike } from '../../renderer/lib/notes/frontmatterFence';

/**
 * A note with no frontmatter whose text opens with a `---` rule (a scene
 * break) and has another `---` rule further down. Written as it is, the next
 * read takes the text between the two rules as frontmatter: it vanishes from
 * the note, and later saves write it twice. The first rule is written as `***`.
 */
const SCENES = '---\n\nScene one.\n\n---\n\nScene two.';

describe('a leading rule in a note without frontmatter', () => {
  it('is written as *** so it reads back as body', () => {
    const file = assembleMarkdownFile({}, SCENES);
    expect(file).toBe('***\n\nScene one.\n\n---\n\nScene two.');
    const read = parseMarkdownFile(file);
    expect(read.hasFrontmatter).toBe(false);
    expect(read.body).toContain('Scene one.');
    expect(read.body).toContain('Scene two.');
  });

  it('keeps CRLF and a BOM', () => {
    const file = assembleMarkdownFile({}, SCENES.replace(/\n/g, '\r\n'), { bom: true });
    expect(file).toBe('\uFEFF***\r\n\r\nScene one.\r\n\r\n---\r\n\r\nScene two.');
    expect(parseMarkdownFile(file).hasFrontmatter).toBe(false);
  });

  it('leaves a body alone when nothing would pair with its first rule', () => {
    expect(bodyWithoutFenceLookalike('---\n\nOnly one rule.')).toBe('---\n\nOnly one rule.');
    expect(bodyWithoutFenceLookalike('Text\n\n---\n\nMore')).toBe('Text\n\n---\n\nMore');
  });

  it('a note with frontmatter keeps its leading body rule', () => {
    const file = assembleMarkdownFile({ title: 'T' }, SCENES);
    expect(file.startsWith('---\ntitle: T\n---\n---\n')).toBe(true);
    const read = parseMarkdownFile(file);
    expect(read.frontmatter).toEqual({ title: 'T' });
    expect(read.body).toContain('Scene one.');
  });
});
