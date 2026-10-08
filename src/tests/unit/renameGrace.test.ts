/**
 * `askUnlessMoved`: a note whose file vanished may be mid-rename by another
 * program, so "deleted?" / "couldn't save" prompts wait out a grace first and
 * ask only if the note is still in question and the file is still gone.
 * Asking too early would put a prompt over a note that merely moved; asking
 * after a vault swap would prompt about a vault the user already left.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { askUnlessMoved, dropGraceChecks, settleGraceChecksNow } from '@renderer/lib/notes/renameGrace';
import { NOTE_RENAME_GRACE_MS } from '@renderer/lib/vault/externalChangeWindows';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

let exists: boolean | Error | undefined = false;
const calls: unknown[][] = [];

function spies(): { stillHere: ReturnType<typeof vi.fn<() => boolean>>; ask: ReturnType<typeof vi.fn<() => void>>; onBack: ReturnType<typeof vi.fn<() => void>> } {
  return {
    stillHere: vi.fn<() => boolean>(() => true),
    ask: vi.fn<() => void>(),
    onBack: vi.fn<() => void>(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  exists = false;
  calls.length = 0;
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel !== 'vault:file-exists') return undefined;
    calls.push(args);
    if (exists instanceof Error) throw exists;
    return exists;
  });
});

afterEach(() => {
  dropGraceChecks();
  vi.useRealTimers();
  setActiveVaultPath('');
  __resetVaultIdentityForTests();
  restoreFiloDefault();
});

describe('askUnlessMoved', () => {
  it('waits the whole grace before checking, then asks when the file is still gone', async () => {
    const s = spies();
    askUnlessMoved('Notes/A.md', s.stillHere, s.ask, s.onBack);

    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS - 1);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([['/vault', 'Notes/A.md']]);
    expect(s.ask).toHaveBeenCalledTimes(1);
    expect(s.onBack).not.toHaveBeenCalled();
  });

  it('runs onBack instead when the file is there again', async () => {
    exists = true;
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.onBack).toHaveBeenCalledTimes(1);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('treats a non-true answer as gone', async () => {
    exists = undefined;
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.ask).toHaveBeenCalledTimes(1);
  });

  it('treats a failed existence check as gone (asks rather than stays silent)', async () => {
    exists = new Error('ipc down');
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.ask).toHaveBeenCalledTimes(1);
    expect(s.onBack).not.toHaveBeenCalled();
  });

  it('does nothing, not even the disk check, once the note is no longer in question', async () => {
    const s = spies();
    s.stillHere.mockReturnValue(false);
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.onBack).not.toHaveBeenCalled();
  });

  it('does nothing when the note is settled while the disk check is in flight', async () => {
    const s = spies();
    let answered = false;
    installFiloMock((channel: string) => {
      if (channel !== 'vault:file-exists') return undefined;
      // The rename lands (and re-keys the note) during the round trip.
      s.stillHere.mockReturnValue(false);
      answered = true;
      return false;
    });
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(answered).toBe(true);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.onBack).not.toHaveBeenCalled();
  });

  it('does nothing after a vault swap', async () => {
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    beginVaultGeneration('/other');
    setActiveVaultPath('/other');
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('does nothing after the same vault is closed and reopened (a new generation)', async () => {
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    beginVaultGeneration('/vault');
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('does nothing when the vault swaps while the disk check is in flight', async () => {
    const s = spies();
    installFiloMock((channel: string) => {
      if (channel !== 'vault:file-exists') return undefined;
      beginVaultGeneration('/other');
      return false;
    });
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.onBack).not.toHaveBeenCalled();
  });

  it('does nothing with no active vault path', async () => {
    const s = spies();
    setActiveVaultPath('');
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('keeps separate checks for separate notes', async () => {
    const a = spies();
    const b = spies();
    askUnlessMoved('A.md', a.stillHere, a.ask, a.onBack);
    await vi.advanceTimersByTimeAsync(1000);
    askUnlessMoved('B.md', b.stillHere, b.ask, b.onBack);

    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS - 1000);
    expect(a.ask).toHaveBeenCalledTimes(1);
    expect(b.ask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(b.ask).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c[1])).toEqual(['A.md', 'B.md']);
  });
});

describe('askUnlessMoved asks the watcher where the file went at once', () => {
  it('requests a walk now, and a move it reports settles the note before the grace ends: no prompt', async () => {
    const s = spies();
    const walks: unknown[][] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:reconcile') {
        walks.push(args);
        // The walk found the note moved; the rename re-keys it.
        s.stillHere.mockReturnValue(false);
        return { success: true };
      }
      if (channel === 'vault:file-exists') {
        calls.push(args);
        return false;
      }
      return undefined;
    });
    askUnlessMoved('Places/Castle.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(0);
    expect(walks).toEqual([[{ now: true }]]);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('waits for a walk slower than the grace before it asks', async () => {
    const s = spies();
    let finishWalk!: () => void;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:reconcile') return new Promise((resolve) => { finishWalk = () => resolve({ success: true }); });
      if (channel === 'vault:file-exists') {
        calls.push(args);
        return false;
      }
      return undefined;
    });
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS + 2000);
    expect(s.ask).not.toHaveBeenCalled();
    finishWalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ask).toHaveBeenCalledTimes(1);
  });

  it('a failed walk leaves the grace to decide', async () => {
    const s = spies();
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:reconcile') throw new Error('no watcher');
      if (channel === 'vault:file-exists') {
        calls.push(args);
        return false;
      }
      return undefined;
    });
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS);
    expect(s.ask).toHaveBeenCalledTimes(1);
  });
});

describe('dropGraceChecks', () => {
  it('cancels every waiting check', async () => {
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);
    askUnlessMoved('B.md', s.stillHere, s.ask, s.onBack);
    dropGraceChecks();
    await vi.advanceTimersByTimeAsync(NOTE_RENAME_GRACE_MS * 2);
    expect(calls).toHaveLength(0);
    expect(s.ask).not.toHaveBeenCalled();
  });
});

describe('settleGraceChecksNow', () => {
  it('runs waiting checks at once, and each only once', async () => {
    vi.useRealTimers();
    const s = spies();
    askUnlessMoved('A.md', s.stillHere, s.ask, s.onBack);

    await settleGraceChecksNow();
    expect(s.ask).toHaveBeenCalledTimes(1);

    // The grace timer was cleared: nothing runs a second time.
    await settleGraceChecksNow();
    expect(s.ask).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('also picks up a check started just after it was called', async () => {
    vi.useRealTimers();
    const s = spies();
    const settling = settleGraceChecksNow();
    askUnlessMoved('Late.md', s.stillHere, s.ask, s.onBack);
    await settling;
    expect(s.ask).toHaveBeenCalledTimes(1);
  });

  it('resolves with nothing waiting', async () => {
    vi.useRealTimers();
    await expect(settleGraceChecksNow()).resolves.toBeUndefined();
  });
});
