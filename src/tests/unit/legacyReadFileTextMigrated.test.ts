import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateIpcPayload } from '../../shared/ipcSchemas';

/**
 * IMPL_PLAN_2026-05-23_v2 P0.1 — seven legacy `vault:read-file-text` call
 * sites passed one concatenated absolute path; the schema requires the
 * canonical tuple `[vaultRoot, relativePath]`. The validator rejection
 * silently fell back to stale content, then the next save overwrote disk
 * with empty/stale content (data loss).
 *
 * Two assertions pin the fix:
 *
 * 1. The IPC schema enforces a 2-tuple at runtime (preload validator).
 *    Single-arg or 3-arg calls are rejected.
 *
 * 2. No file under `src/renderer/` re-introduces the legacy call shape.
 *    The `ci:legacy-read` gate enforces this in CI; this test mirrors it
 *    inside the unit suite so a regression surfaces in fast feedback
 *    rather than waiting for the full `ci:verify` run.
 */

describe('vault:read-file-text — canonical schema shape', () => {
  it('accepts the canonical (vaultRoot, relativePath) tuple', () => {
    expect(
      validateIpcPayload('vault:read-file-text', ['/vault', 'notes/Foo.md']),
    ).toEqual({ ok: true });
  });

  it('rejects a legacy single-arg absolute-path call', () => {
    // Pre-Phase-37/37.6 callers built one concatenated absolute path and
    // passed it as a single string. The validator rejection is the entire
    // point of having ipcSchemas — pin it so a regression in the schema
    // entry surfaces immediately.
    const r = validateIpcPayload('vault:read-file-text', ['/vault/notes/Foo.md']);
    expect(r.ok).toBe(false);
  });

  it('rejects an extra trailing arg', () => {
    const r = validateIpcPayload('vault:read-file-text', [
      '/vault',
      'notes/Foo.md',
      'stray',
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-string vaultRoot', () => {
    const r = validateIpcPayload('vault:read-file-text', [42, 'notes/Foo.md']);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty vaultRoot string', () => {
    const r = validateIpcPayload('vault:read-file-text', ['', 'notes/Foo.md']);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty relativePath string', () => {
    const r = validateIpcPayload('vault:read-file-text', ['/vault', '']);
    expect(r.ok).toBe(false);
  });
});

const SRC_ROOT = resolve(__dirname, '../../');
const SCAN_DIRS = ['main', 'renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

// Same heuristics as `scripts/check-legacy-read-file-text.mjs`. The two
// scripts agreeing on the rejection set means the CI gate and unit suite
// can't drift apart silently.
const LEGACY_TEMPLATE_LITERAL = /['"]vault:read-file-text['"]\s*,\s*`/;
const LEGACY_STRING_CONCAT = /['"]vault:read-file-text['"]\s*,\s*[^,)]*\+/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (
      s.isFile()
      && EXTENSIONS.some((ext) => entry.endsWith(ext))
    ) {
      out.push(full);
    }
  }
}

describe('vault:read-file-text — no legacy call sites in src', () => {
  it('has no remaining single-arg or concatenated-path call forms', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(join(SRC_ROOT, dir), files);
    const offenders: string[] = [];
    for (const abs of files) {
      const lines = readFileSync(abs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (LEGACY_TEMPLATE_LITERAL.test(line) || LEGACY_STRING_CONCAT.test(line)) {
          offenders.push(`${abs}:${i + 1} — ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
