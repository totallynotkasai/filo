import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import {
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * Audit2 5.1 — externally-deleted `.filo/` config must NOT be resurrected by
 * the next debounced write. The pre-write `vault:stat` probe was already in
 * place for drift detection, but its catch swallowed ENOENT and fell through
 * to the `config:save` IPC, which `mkdir -p`'d the parent and re-created the
 * file. The guard now mirrors `writeBoardFile`'s ENOENT short-circuit:
 * when the file was previously known to exist (`baseline !== undefined`) and
 * the pre-write stat says it's gone, skip the target as a clean no-op.
 *
 * Fresh configs (no baseline) are still allowed to write — initial
 * `configOps.initVaultConfig` writes happen before any baseline is noted, so
 * the seed path is unaffected.
 */

const VAULT_ROOT = '/vault';

function makeSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
  return {
    general: {
      // Use a unique value per call so the payload differs from any
      // previously-cached `lastWrittenConfigs` entry and the write isn't
      // dedup-skipped.
      globalFont: `test-font-${Math.floor(performance.now() * 1000)}`,
    },
    mindmap: {},
    kanban: {},
    tasklist: {},
    document: {},
    ...overrides,
  } as ProjectSettings;
}

function makeWorkspace(): WorkspaceState {
  return { openTabs: [], activeTabId: '' };
}

describe('configWriteScheduler — ENOENT skip-on-resurrection (5.1)', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
  });

  it('skips a target whose pre-write stat reports ENOENT (does not resurrect)', async () => {
    // Seed a baseline for `.filo/defaults.json` so the writer takes the
    // drift-check branch. The actual values don't matter — only "baseline
    // exists" gates the stat probe.
    noteBaseline('.filo/defaults.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        const [, relPath] = args as [string, string];
        if (relPath === '.filo/defaults.json') {
          // Simulate the file was deleted externally.
          return Promise.resolve({ ok: false, code: 'ENOENT', error: 'not found' });
        }
        // Other config files still exist.
        return Promise.resolve({ ok: true, mtimeMs: 2000, size: 99 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    // defaults.json must NOT have been written — the deleted file stays deleted.
    const defaultsSaveCalls = calls.filter(
      (c) => c.channel === 'config:save' && c.args[1] === 'defaults.json',
    );
    expect(defaultsSaveCalls).toHaveLength(0);

    // The skip is a clean no-op, not a failure — `failed` does not include it.
    expect(result.failed).not.toContain('defaults.json');
  });

  it('still writes targets whose file is present (no over-blocking)', async () => {
    noteBaseline('.filo/defaults.json', 1000, 50);
    noteBaseline('.filo/app.json', 1000, 50);

    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        // Both files still exist with their baseline mtime/size — no drift.
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    expect(result.failed).toEqual([]);
    // At least one config:save call landed (the test ran past the dedupe).
    expect(calls.some((c) => c.channel === 'config:save')).toBe(true);
  });

  it('still writes a fresh target with no baseline (initial seed unaffected)', async () => {
    // No noteBaseline calls — the baseline registry is empty, so the
    // pre-write stat probe is skipped entirely.
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'config:save' || channel === 'config:save-workspace') {
        return Promise.resolve({ ok: true });
      }
      // If vault:stat IS called, surface the failure so the test fails
      // loudly rather than silently dropping the write.
      if (channel === 'vault:stat') {
        throw new Error('vault:stat should not be called when no baseline exists');
      }
      return Promise.resolve(undefined);
    });

    const result = await writeConfigs(
      VAULT_ROOT,
      makeSettings(),
      'light',
      makeWorkspace(),
    );

    expect(result.failed).toEqual([]);
    expect(calls.some((c) => c.channel === 'config:save')).toBe(true);
  });
});
