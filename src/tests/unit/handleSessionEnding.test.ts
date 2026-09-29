import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleSessionEnding,
  __resetSessionEndingForTests,
  SESSION_SAVE_BOUND_MS,
  type SessionEndingDeps,
} from '@renderer/lib/vault/handleSessionEnding';
import { keepRescueCopies } from '@renderer/stores/unsavedRescue';
import { registerThemeEditor } from '@renderer/lib/themes/themeEditorGuard';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { RescueResult } from '@renderer/lib/vault/unsavedMessages';

/**
 * Windows ending the session: no dialog. Save what can be saved, keep rescue
 * copies of the rest (unapplied Settings included), then tell main it may go,
 * even when a step fails or runs out of time.
 */

const NO_RESCUE: RescueResult = { dir: null, kept: [], notKept: [] };

function fakeDeps(over: Partial<SessionEndingDeps> = {}): { deps: SessionEndingDeps; log: string[] } {
  const log: string[] = [];
  const deps: SessionEndingDeps = {
    save: async () => {
      log.push('save');
      return true;
    },
    freeze: () => {
      log.push('freeze');
      return () => log.push('thaw');
    },
    nothingUnsaved: () => true,
    heldDecisionCount: () => 0,
    openSettingsEdits: () => false,
    keepRescueCopies: async (opts) => {
      log.push(`rescue:${opts.unappliedSettings}`);
      return NO_RESCUE;
    },
    flushSentinel: async () => {
      log.push('sentinel');
    },
    send: (channel) => log.push(channel),
    reportError: (_c, _e, msg) => log.push(`error:${msg}`),
    ...over,
  };
  return { deps, log };
}

describe('handleSessionEnding', () => {
  beforeEach(() => __resetSessionEndingForTests());

  it('saves, then tells main; nothing left means no rescue copies', async () => {
    const { deps, log } = fakeDeps();
    await handleSessionEnding(deps);
    expect(log).toEqual(['freeze', 'save', 'sentinel', 'thaw', 'app:session-ending-done']);
  });

  it('a change waiting for an answer is kept as a rescue copy', async () => {
    const { deps, log } = fakeDeps({ nothingUnsaved: () => false, heldDecisionCount: () => 1 });
    await handleSessionEnding(deps);
    expect(log).toEqual(['freeze', 'save', 'rescue:false', 'sentinel', 'thaw', 'app:session-ending-done']);
  });

  it('unapplied Settings are kept too', async () => {
    const { deps, log } = fakeDeps({ openSettingsEdits: () => true });
    await handleSessionEnding(deps);
    expect(log).toContain('rescue:true');
  });

  it('a save that hangs is given up on, and the rescue and the reply still happen', async () => {
    vi.useFakeTimers();
    try {
      const { deps, log } = fakeDeps({ save: () => new Promise(() => {}), nothingUnsaved: () => false });
      const done = handleSessionEnding(deps);
      await vi.advanceTimersByTimeAsync(SESSION_SAVE_BOUND_MS);
      await done;
      expect(log).toEqual(['freeze', 'rescue:false', 'sentinel', 'thaw', 'app:session-ending-done']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rescue that throws is reported, and main is still told', async () => {
    const { deps, log } = fakeDeps({
      nothingUnsaved: () => false,
      keepRescueCopies: async () => {
        throw new Error('disk gone');
      },
    });
    await handleSessionEnding(deps);
    expect(log.some((l) => l.startsWith('error:Keeping copies'))).toBe(true);
    expect(log.at(-1)).toBe('app:session-ending-done');
  });
});

describe('rescue copies of unapplied Settings', () => {
  let kept: Array<{ relPath: string; text: string }>;
  beforeEach(() => {
    kept = [];
    setActiveVaultPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'recovery:keep-unsaved') {
        kept = args[1] as Array<{ relPath: string; text: string }>;
        return { ok: true, dir: '.filo/recovery/1-unsaved', kept: kept.map((i) => i.relPath), failed: [] };
      }
      return undefined;
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    setActiveVaultPath('');
  });

  it('keeps the theme being edited, only when asked to', async () => {
    const unregister = registerThemeEditor({
      name: () => 'Dusk',
      isDirty: () => true,
      save: async () => true,
      draft: () => JSON.stringify({ name: 'Dusk', variables: { '--ui-accent': '#123456' } }),
    });
    try {
      await keepRescueCopies({ pending: [], failed: [], inflight: 0 });
      expect(kept).toEqual([]);

      const result = await keepRescueCopies({ pending: [], failed: [], inflight: 0 }, { unappliedSettings: true });
      expect(result.dir).toBe('.filo/recovery/1-unsaved');
      expect(kept.map((i) => i.relPath)).toEqual(['_filo__themes__theme.unapplied.json']);
      expect(kept[0]!.text).toContain('#123456');
    } finally {
      unregister();
    }
  });
});
