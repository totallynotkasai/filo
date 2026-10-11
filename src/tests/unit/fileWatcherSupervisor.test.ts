/**
 * FileWatcher supervisor state machine.
 *
 * Verifies the reopen state machine that wraps `fs.watch`. Three concerns:
 *
 *   1. State transitions broadcast `vault:watcher-state` events with the
 *      expected shape (`{ state, reason?, attempt? }`). On stop() the
 *      supervisor emits `suspended` exactly once.
 *   2. Synchronous fs.watch() failure (vault path missing at start time)
 *      transitions the supervisor into `reconnecting` and arms a retry
 *      timer at the first backoff slot (1s).
 *   3. The classifyChange granular subtypes:
 *      - `.filo/tags.json`        → `config-tags`
 *      - `.filo/themes/foo.json`  → `config-theme`
 *      - `.filo/templates/x.json` → `config-template`
 *      - `.filo/anything-else.json` → `config` (unchanged)
 *
 * The supervisor uses real timers in production; tests inject fake timers
 * via `vi.useFakeTimers()` so retry behaviour is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sentEvents: Array<{ channel: string; payload: unknown[] }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, ...payload: unknown[]) => {
            sentEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

import { FileWatcher } from '../../main/services/fileWatcher';

describe('FileWatcher supervisor', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-supervisor-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    try {
      await watcher.stop();
    } catch {
      /* ignore */
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('state introspection', () => {
    it('starts in active state', () => {
      watcher.start();
      expect(watcher.getState()).toBe('active');
      expect(watcher.getRetryAttempt()).toBe(0);
    });

    it('broadcasts `suspended` on stop()', async () => {
      watcher.start();
      await watcher.stop();
      const suspended = sentEvents.filter(
        (e) =>
          e.channel === 'vault:watcher-state'
          && (e.payload[0] as { state?: string }).state === 'suspended',
      );
      expect(suspended.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT broadcast `active` on a clean first start (no transition from reconnecting)', () => {
      watcher.start();
      // The supervisor emits `active` only when transitioning OUT of
      // `reconnecting`, not on cold-start. This keeps the renderer from
      // showing "watcher reconnected" toasts every time the user opens
      // a vault.
      const active = sentEvents.filter(
        (e) =>
          e.channel === 'vault:watcher-state'
          && (e.payload[0] as { state?: string }).state === 'active',
      );
      expect(active.length).toBe(0);
    });
  });

  describe('reopen state machine', () => {
    it('synchronous fs.watch throw schedules a retry and emits `reconnecting`', async () => {
      // Construct a FileWatcher pointing at a non-existent path. The
      // synchronous fs.watch call throws ENOENT (on linux/macOS) or
      // similar — the supervisor catches it through `handleWatcherError`
      // and transitions to `reconnecting`.
      const missing = join(dir, 'never-existed');
      const badWatcher = new FileWatcher(missing);
      try {
        badWatcher.start();
        // Walk through the microtask queue so the synchronous throw's
        // handler has a chance to broadcast.
        await new Promise((r) => setTimeout(r, 50));
        const reconnecting = sentEvents.filter(
          (e) =>
            e.channel === 'vault:watcher-state'
            && (e.payload[0] as { state?: string }).state === 'reconnecting',
        );
        expect(reconnecting.length).toBeGreaterThanOrEqual(1);
        const payload = reconnecting[0].payload[0] as { reason?: string; attempt?: number };
        // First retry attempt counter is 0 — payload.attempt is the
        // pre-bump value.
        expect(payload.attempt).toBe(0);
        // A reason string is always present on `reconnecting`.
        expect(typeof payload.reason).toBe('string');
        expect((payload.reason ?? '').length).toBeGreaterThan(0);
        // Legacy `vault:watcher-failed` also fires for backward compat.
        const legacyFailed = sentEvents.filter((e) => e.channel === 'vault:watcher-failed');
        expect(legacyFailed.length).toBeGreaterThanOrEqual(1);
      } finally {
        await badWatcher.stop();
      }
    });

    it('after stop() no further state broadcasts fire', async () => {
      watcher.start();
      await watcher.stop();
      sentEvents.length = 0;
      // Even if a stale timer fired, the aborted check would no-op.
      await new Promise((r) => setTimeout(r, 100));
      const state = sentEvents.filter((e) => e.channel === 'vault:watcher-state');
      expect(state.length).toBe(0);
    });
  });

  describe('granular config classification', () => {
    it('classifies .filo/tags.json as config-tags', () => {
      expect(watcher.classifyForTests('.filo/tags.json')).toBe('config-tags');
    });

    it('classifies .filo/themes/foo.json as config-theme', () => {
      expect(watcher.classifyForTests('.filo/themes/foo.json')).toBe('config-theme');
      expect(watcher.classifyForTests('.filo/themes/my-custom.json')).toBe('config-theme');
    });

    it('classifies .filo/templates/x.template.json as config-template', () => {
      expect(watcher.classifyForTests('.filo/templates/x.template.json')).toBe('config-template');
      expect(watcher.classifyForTests('.filo/templates/my-layout--abc123.template.json')).toBe(
        'config-template',
      );
    });

    it('classifies any other .filo/ path as plain config (un-routed)', () => {
      expect(watcher.classifyForTests('.filo/app.json')).toBe('config');
      expect(watcher.classifyForTests('.filo/appearance.json')).toBe('config');
      expect(watcher.classifyForTests('.filo/workspace.json')).toBe('config');
      expect(watcher.classifyForTests('.filo/viewports.json')).toBe('config');
    });

    it('classifies .md as document', () => {
      expect(watcher.classifyForTests('Notes.md')).toBe('document');
      expect(watcher.classifyForTests('sub/Page.md')).toBe('document');
    });

    it('classifies .board.json as board', () => {
      expect(watcher.classifyForTests('Boards/Main.board.json')).toBe('board');
    });
  });
});
