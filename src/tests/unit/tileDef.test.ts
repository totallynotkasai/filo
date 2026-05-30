import { describe, it, expect } from 'vitest';
import { TileDefinitionSchema } from '@renderer/schema/tile';

/**
 * Phase R5 — `TileDefinitionSchema` is a Zod discriminated union with per-type
 * required fields. The validations below close the "hostile URL via
 * hand-edited tileDef" hole that `.passthrough()` on the previous flat base
 * left wide open.
 *
 *   - Acceptance criteria 2: `javascript:` URL on a link def fails parse.
 *   - Acceptance criteria 3: an image def missing `src` fails parse.
 *   - Acceptance criteria 4: a forward-compat field on a link def survives
 *     round-trip — passthrough still applies inside each variant.
 */
describe('Phase R5 — discriminated TileDefinitionSchema', () => {
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

    it('rejects a text def missing `contentId`', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
      });
      expect(r.success).toBe(false);
    });
  });

  describe('forward-compat passthrough survives round-trip', () => {
    it('preserves a future field on a link def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'link',
        url: 'https://example.com',
        futureField: 'y',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        // Cast through unknown because passthrough fields are typed
        // `unknown` and invisible to the schema-typed `TileDefinition`
        // view (CLAUDE.md / `schema/tile.ts` passthrough contract).
        const widened = r.data as unknown as Record<string, unknown>;
        expect(widened.futureField).toBe('y');
      }
    });

    it('preserves a future field on a text def', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
        contentId: 'doc_1',
        newFutureField: { sub: 'value' },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        const widened = r.data as unknown as Record<string, unknown>;
        expect(widened.newFutureField).toEqual({ sub: 'value' });
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

  describe('task-metadata strip preprocess survives the union', () => {
    it('strips `completed` / `dueDate` from a text def before discriminator parse', () => {
      const r = TileDefinitionSchema.safeParse({
        ...baseFields,
        type: 'text',
        contentId: 'doc_1',
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
