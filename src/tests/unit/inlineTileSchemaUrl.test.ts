import { describe, it, expect } from 'vitest';
import { InlineTileSchema } from '@renderer/schema/placement';

/**
 * `InlineTileSchema` previously used `.passthrough()`, so a
 * hand-edited `.board.json` could carry an inline-tile `url` with any
 * scheme — including `javascript:` / `data:` / `file:`, which would reach
 * the renderer DOM unchecked. The tightened schema validates `url` via the
 * shared `tileUrlString` refinement (empty, http(s), or about:blank only).
 *
 * Numeric timer fields (`duration`, `remaining`) gain `.finite()` and the
 * known `mode` enum is enforced.
 */

function makeBaseInlineTile(extra: Record<string, unknown>) {
  return {
    id: 'inline_1',
    type: 'link',
    title: 'Example',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    locked: false,
    faded: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe('InlineTileSchema — URL scheme validation', () => {
  it('accepts an empty url (default state for new tiles)', () => {
    const parsed = InlineTileSchema.safeParse(makeBaseInlineTile({ url: '' }));
    expect(parsed.success).toBe(true);
  });

  it('accepts http:// urls', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'http://example.com' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts https:// urls', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'https://example.com/path?q=1' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('REJECTS javascript: urls (XSS vector)', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'javascript:alert(1)' }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Zod error should mention the offending field.
      const issue = parsed.error.issues.find((i) => i.path.includes('url'));
      expect(issue).toBeTruthy();
    }
  });

  it('REJECTS data: urls (inline-payload bypass)', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'data:text/html,<script>alert(1)</script>' }),
    );
    expect(parsed.success).toBe(false);
  });

  it('REJECTS file: urls (local-file exfil)', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'file:///etc/passwd' }),
    );
    expect(parsed.success).toBe(false);
  });

  it('REJECTS blob: urls (foreign-origin probe)', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ url: 'blob:https://evil.com/abc' }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('InlineTileSchema — numeric + enum tightening', () => {
  it('rejects a non-finite duration (NaN)', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ type: 'timer', duration: Number.NaN, remaining: 0 }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an Infinity remaining', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ type: 'timer', remaining: Number.POSITIVE_INFINITY }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown timer mode', () => {
    const parsed = InlineTileSchema.safeParse(
      makeBaseInlineTile({ type: 'timer', mode: 'pomodoro' as unknown as 'hms' }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts the canonical hms / ms / s / clock modes', () => {
    for (const mode of ['hms', 'ms', 's', 'clock'] as const) {
      const parsed = InlineTileSchema.safeParse(
        makeBaseInlineTile({ type: 'timer', mode }),
      );
      expect(parsed.success).toBe(true);
    }
  });
});
