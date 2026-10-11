/**
 * Contract — IPC envelope contract.
 *
 * For every envelope-returning channel in `src/main/ipc/board.ipc.ts`, this
 * file asserts that the renderer-side caller threads the result through
 * `assertIpcOk` (or a typed wrapper that fronts it). The assertion runs as
 * a source-scan inside the test — we walk the renderer tree, find every
 * `invoke('channel', ...)` callsite, and look at the surrounding ±10 lines
 * for an `assertIpcOk` consumer. The `ipc-envelope-usage` gate
 * (`scripts/gates/ipcSecurity.mjs`) polices the same surface in CI.
 *
 * Why this matters: when a renderer caller forgets `assertIpcOk` on an
 * envelope channel, an `{ ok: false, error }` failure mode looks like a
 * resolved success on the renderer side — the disk write didn't happen,
 * but the UI proceeds as though it had.
 *
 * Every envelope-returning channel in `board.ipc.ts` must have either an
 * `assertIpcOk` / `invokeOk` consumer in scope or an explicit
 * `// allow-envelope-bare:` annotation on the caller.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Source-scan helpers ────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');

function walk(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) results.push(full);
  }
  return results;
}

const RENDERER_FILES = walk(RENDERER_DIR, ['.ts', '.svelte']);

interface CallSite {
  file: string;
  line: number;
  /**
   * True if the call is enveloped-compliantly handled: `assertIpcOk` /
   * `invokeOk` appears within ±10 lines of the call, OR the call is
   * annotated with `// allow-envelope-bare:` (matching the
   * `scripts/gates:ipc-envelope-usage` CI gate's escape hatch).
   */
  hasNearbyAssertIpcOk: boolean;
  /** Excerpt of the call's surrounding context for debugging. */
  excerpt: string;
}

function findCallers(channel: string): CallSite[] {
  const callers: CallSite[] = [];
  // Match bare `invoke('channel'` only — `invokeOk('channel'` (the safe
  // wrapper) does NOT satisfy `invoke('channel'` because of the `Ok` in
  // between, so it is automatically excluded from the caller scan.
  const needles = [`invoke('${channel}'`, `invoke("${channel}"`];
  for (const file of RENDERER_FILES) {
    const text = fs.readFileSync(file, 'utf-8');
    if (!needles.some((n) => text.includes(n))) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matched = needles.some((n) => lines[i].includes(n));
      if (!matched) continue;
      // Exclude `invokeOk('channel'` callers — the needle accidentally
      // can match the substring `invoke('channel'` if `Ok` is absent on
      // a line-wrapped form; defensively re-check the literal text.
      if (/\binvokeOk\s*\(/.test(lines[i])) continue;
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length, i + 12);
      const block = lines.slice(start, end).join('\n');
      const hasAssertIpcOk = /assertIpcOk\b/.test(block);
      const hasInvokeOk = /\binvokeOk\b/.test(block);
      const hasBareEscape = /allow-envelope-bare:/.test(block);
      callers.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        hasNearbyAssertIpcOk: hasAssertIpcOk || hasInvokeOk || hasBareEscape,
        excerpt: block,
      });
    }
  }
  return callers;
}

// ── Channel inventory ──────────────────────────────────────────────────

/**
 * Envelope channels declared in `src/main/ipc/board.ipc.ts`. This test is
 * scoped to that single IPC file.
 */
const BOARD_IPC_ENVELOPE_CHANNELS = [
  'vault:init-config',
  'board:save',
  'board:create',
  'config:save',
  'config:save-workspace',
  'theme:save',
  'theme:delete',
  'recovery:snapshot',
  // theme:load is a HYBRID channel:
  //   - bare ThemeFile (data) or null on success / ENOENT
  //   - { ok: false, code: 'invalid-json', name } envelope on parse error
  // Renderer callers detect the envelope inline via `isThemeParseFailure`
  // rather than `assertIpcOk` since the success path still returns the
  // bare data (compat with legacy callers and existing tests).
  'theme:load',
] as const;

// ── Tests ──────────────────────────────────────────────────────────────

describe('Contract — IPC envelope contract (board.ipc.ts)', () => {
  describe('every envelope channel handler in board.ipc.ts is enumerated above', () => {
    it('source listing matches the test inventory', () => {
      const handlerSource = fs.readFileSync(
        path.join(ROOT, 'src', 'main', 'ipc', 'board.ipc.ts'),
        'utf-8',
      );
      const lines = handlerSource.split('\n');
      const handlersWithEnvelope = new Set<string>();
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/ipcMain\.handle\(['"]([^'"]+)['"]/);
        if (!m) continue;
        const channel = m[1];
        // Look ahead up to the next handler for `return { ok: true|false`
        for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
          if (/ipcMain\.handle\(['"]/.test(lines[j])) break;
          if (/return\s+\{\s*ok:\s*(true|false)/.test(lines[j])) {
            handlersWithEnvelope.add(channel);
            break;
          }
        }
      }
      const expected = new Set<string>(BOARD_IPC_ENVELOPE_CHANNELS);
      // Symmetric-diff: every handler-with-envelope must appear in our
      // inventory; every inventory entry must appear in the source.
      const onlyInSource = [...handlersWithEnvelope].filter((c) => !expected.has(c));
      const onlyInInventory = [...expected].filter((c) => !handlersWithEnvelope.has(c));
      expect({ onlyInSource, onlyInInventory }).toEqual({
        onlyInSource: [],
        onlyInInventory: [],
      });
    });
  });

  // ── Per-channel caller assertions ────────────────────────────────────

  // Sites that already consume the envelope via assertIpcOk. These tests
  // pass today and lock the contract in place.
  describe('renderer callers thread envelope through assertIpcOk', () => {
    // PASSING TODAY: board:save / config:save / config:save-workspace /
    // theme:save / theme:delete — already wired through the typed
    // schedulers + store helpers.
    const PASSING_TODAY: Array<typeof BOARD_IPC_ENVELOPE_CHANNELS[number]> = [
      'board:save',
      'config:save',
      'config:save-workspace',
      'theme:save',
      'theme:delete',
    ];

    for (const channel of PASSING_TODAY) {
      it(`${channel} — every renderer caller has assertIpcOk in scope`, () => {
        const callers = findCallers(channel);
        if (callers.length === 0) {
          // No bare renderer caller — the channel is fire-and-forget from
          // main, is called only through `invokeOk` (excluded from this scan),
          // OR is invoked through a wrapper that obfuscates the literal name.
          // An empty caller list is acceptable.
          return;
        }
        const missing = callers.filter((c) => !c.hasNearbyAssertIpcOk);
        if (missing.length > 0) {
          throw new Error(
            `Envelope channel "${channel}" has ${missing.length} renderer caller(s) ` +
              `without a nearby assertIpcOk:\n` +
              missing
                .map((m) => `  ${m.file}:${m.line}\n${indent(m.excerpt, '    | ')}`)
                .join('\n\n'),
          );
        }
      });
    }
  });

  // Renderer callers of these channels route through `invokeOk` or are
  // marked `// allow-envelope-bare:`; these assertions pin that.
  describe('renderer callers no longer swallow the envelope', () => {
    // boardLoader.ts + vault.svelte.ts route through `invokeOk`. The one
    // remaining bare site (dirtyFlagRecovery.ts:190) is annotated
    // `// allow-envelope-bare:` because the snapshot is a defensive
    // best-effort backup whose failure is deliberately swallowed (the
    // primary error already has its own toast).
    it('recovery:snapshot — every renderer caller has assertIpcOk in scope', () => {
      const callers = findCallers('recovery:snapshot');
      const missing = callers.filter((c) => !c.hasNearbyAssertIpcOk);
      expect(missing).toEqual([]);
    });

    // vault.svelte.ts:951 and vaultCandidate.ts:140 both use `invokeOk`; no
    // bare callers remain.
    it('vault:init-config — every renderer caller has assertIpcOk in scope', () => {
      const callers = findCallers('vault:init-config');
      const missing = callers.filter((c) => !c.hasNearbyAssertIpcOk);
      expect(missing).toEqual([]);
    });

    // boardCache.svelte.ts:578-583 uses `invokeOk('board:create', ...)`. No
    // bare callers remain; the assertion is structurally identical to the
    // others above.
    it('board:create — every renderer caller has assertIpcOk in scope', () => {
      const callers = findCallers('board:create');
      const missing = callers.filter((c) => !c.hasNearbyAssertIpcOk);
      expect(missing).toEqual([]);
    });
  });
});

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
