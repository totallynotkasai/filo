import { describe, it, expect } from 'vitest';
import { TileDefinitionSchema } from '@renderer/schema/tile';

/**
 * `TileDefinitionSchema` is a Zod discriminated union with per-type required
 * fields, and no variant passes unknown keys through:
 *
 *   - a `javascript:` URL on a link def fails parse (hostile URL via a
 *     hand-edited tileDef);
 *   - an image def missing `src` / a text def missing `filePath` fails parse;
 *   - a key the board doesn't own (a text def's title / tags / body, a leaked
 *     task field, an unknown key) is dropped on parse, so it can't survive a
 *     load and save.
 */
describe('discriminated TileDefinitionSchema', () => {
  const baseFields = {
    id: 't1',
    title: 'T',
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    createdAt: 1700000000_000,
    updatedAt: 1700000000_000,
  };

  describe('URL safety on link / iframe defs', () => {
    it('rejects a `javascript:` URL on a link def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'javascript:alert(1)',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a `javascript:` URL on an iframe def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'iframe',
        url: 'javascript:alert(1)',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a `data:` URL on a link def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'data:text/html,<script>alert(1)</script>',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a `file:` URL on an iframe def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'iframe',
        url: 'file:///etc/passwd',
      });
      expect(r.success).toBe(false);
    });

    it('accepts `https:` URLs on link / iframe defs', () => {
      const link = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'https://example.com',
      });
      const iframe = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'iframe',
        url: 'https://example.com',
      });
      expect(link.success).toBe(true);
      expect(iframe.success).toBe(true);
    });

    it('accepts `about:blank` on link defs', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'about:blank',
      });
      expect(r.success).toBe(true);
    });

    it('defaults an absent `url` to empty string on link defs', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
      });
      expect(r.success).toBe(true);
      if (r.success && r.data.type === 'link') {
        expect(r.data.url).toBe('');
      }
    });
  });

  describe('per-type required fields', () => {
    it('rejects an image def missing `src`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'image',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a video def missing `src`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'video',
      });
      expect(r.success).toBe(false);
    });

    it('rejects an audio def missing `src`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'audio',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a file def missing `filePath`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'file',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a text def missing `filePath`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a text def with an empty `filePath`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
        filePath: '',
      });
      expect(r.success).toBe(false);
    });
  });

  describe('unknown keys are dropped on parse', () => {
    it('drops a future field on a link def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'https://example.com',
        futureField: 'y',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        const widened = r.data as unknown as Record<string, unknown>;
        expect(widened.futureField).toBeUndefined();
        expect(widened.title).toBe('T');
      }
    });

    it('keeps only the note path on a text def (title, tags and body live in the note)', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
        filePath: 'Notes/T.md',
        tags: ['a'],
        content: '<p>body</p>',
        contentId: 'doc_1',
        newFutureField: { sub: 'value' },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(Object.keys(r.data).sort()).toEqual(['createdAt', 'filePath', 'id', 'style', 'type', 'updatedAt']);
        expect(r.data).toMatchObject({ type: 'text', filePath: 'Notes/T.md' });
      }
    });

    it("drops tags from a media def (a media file's tags live in tags.json)", () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'image',
        src: 'a.png',
        tags: ['a'],
      });
      expect(r.success).toBe(true);
      if (r.success) {
        const widened = r.data as unknown as Record<string, unknown>;
        expect(widened.tags).toBeUndefined();
        expect(widened.title).toBe('T');
      }
    });
  });

  describe('discriminator validation', () => {
    it('rejects an unknown `type` value', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'calendar',
      });
      expect(r.success).toBe(false);
    });

    it('routes parse to the matching variant', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'timer',
      });
      expect(r.success).toBe(true);
      if (r.success && r.data.type === 'timer') {
        // Defaults from the timer variant apply.
        expect(r.data.duration).toBe(0);
        expect(r.data.remaining).toBe(0);
        expect(r.data.mode).toBe('hms');
        expect(r.data.isRunning).toBe(false);
      }
    });
  });

  describe('task metadata never survives on a def', () => {
    it('drops `completed` / `dueDate` from a text def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
        filePath: 'T.md',
        completed: true,
        dueDate: '2026-01-01',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        const widened = r.data as unknown as Record<string, unknown>;
        expect(widened.completed).toBeUndefined();
        expect(widened.dueDate).toBeUndefined();
      }
    });
  });
});
