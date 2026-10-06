/**
 * The pure halves of the error states: the board-load failure notice, the
 * media load message, and which files a broken tile may be re-linked to.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boardLoadFailedToast } from '@renderer/lib/boards/boardLoadFailedNotice';
import { mediaErrorText } from '@renderer/lib/utils/mediaErrorText';
import { relinkTargets, relinkAccepts, relinkTargetsLabel } from '@renderer/lib/vault/relinkTargets';
import type { FailedBoardEntry } from '@renderer/lib/boards/boardLoader';

const entry = (errorKind: FailedBoardEntry['errorKind'], message = 'detail'): FailedBoardEntry => ({
  path: 'Plans/Q3.board.json',
  errorKind,
  message,
});

describe('boardLoadFailedToast', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('broken JSON: plain words, the copy, and the next step', () => {
    const t = boardLoadFailedToast('C:\\Vault', entry('parse-error'), 'C:\\Vault\\.filo\\recovery\\x\\Q3.board.json');
    expect(t.text).toBe(
      'Filo couldn\'t open the board "Plans/Q3.board.json": the file isn\'t valid JSON (it may have been cut short or edited by hand). ' +
        'A copy is in .filo/recovery. Fix the file in a text editor, then reopen the vault.',
    );
    expect(t.sticky).toBe(true);
    expect(t.actions.map((a) => a.label)).toEqual(['Show in folder']);
  });

  it('a field Filo doesn\'t understand names the field', () => {
    const t = boardLoadFailedToast('/v', entry('schema-invalid', 'board.placements.a.x: expected number'), '/v/.filo/recovery/c');
    expect(t.text).toContain('a value in it isn\'t one Filo understands (board.placements.a.x: expected number)');
  });

  it('a newer version says to update Filo; an older one names the copy and no text-editor fix', () => {
    expect(boardLoadFailedToast('/v', entry('from-future', 'Saved by a newer version of Filo.'), '/v/c').text).toMatch(
      /Saved by a newer version of Filo\. A copy is in \.filo\/recovery\. Update Filo, then reopen the vault\.$/,
    );
    expect(boardLoadFailedToast('/v', entry('no-migration-path', 'Made by an older Filo.'), '/v/c').text).toMatch(
      /Made by an older Filo\. A copy is in \.filo\/recovery\.$/,
    );
    expect(boardLoadFailedToast('/v', entry('no-migration-path', 'Made by an older Filo.'), null).text).toMatch(
      /Made by an older Filo\.$/,
    );
  });

  it('no copy kept: no claim that there is one, and Show in folder selects the board file', () => {
    const invoke = vi.fn();
    vi.stubGlobal('window', { filo: { invoke } });
    const t = boardLoadFailedToast('C:/Vault', entry('parse-error'), null);
    expect(t.text).not.toContain('.filo/recovery');
    expect(t.text).toContain('Fix the file in a text editor, then reopen the vault.');
    t.actions[0].handler();
    expect(invoke).toHaveBeenCalledWith('shell:show-item-in-folder', 'C:/Vault/Plans/Q3.board.json');
  });

  it('messages that carry their own next step get no second one', () => {
    const t = boardLoadFailedToast('/v', entry('snapshot-failed', 'Could not preserve it. Back up the file manually.'), null);
    expect(t.text).toBe('Filo couldn\'t open the board "Plans/Q3.board.json". Could not preserve it. Back up the file manually.');
  });
});

describe('mediaErrorText', () => {
  it('a missing file is "File not found", whatever the element reported', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(mediaErrorText(kind, { missing: true, code: 4 })).toBe('File not found');
    }
  });

  it('otherwise the element\'s reason', () => {
    expect(mediaErrorText('audio', { missing: false, code: 4 })).toBe('Audio format not supported by this build.');
    expect(mediaErrorText('video', { missing: false, code: 3 })).toBe('Video file is corrupt or in an unsupported format.');
    expect(mediaErrorText('video', { missing: false, code: null })).toBe('Video could not be loaded');
    expect(mediaErrorText('image', { missing: false })).toBe('Image could not be loaded');
  });
});

describe('relinkTargets', () => {
  it('a file tile accepts any file except a board', () => {
    const any = relinkTargets('file');
    expect(any).toBe('any');
    if (any === null) throw new Error('unreachable');
    expect(relinkAccepts('data.xyz', any)).toBe(true);
    expect(relinkAccepts('Makefile', any)).toBe(true);
    expect(relinkAccepts('Plan.board.json', any)).toBe(false);
    expect(relinkTargetsLabel(any)).toBe('any file');
  });

  it('other tiles accept their own types only, by extension, case-insensitively', () => {
    const text = relinkTargets('text');
    if (text === null) throw new Error('no targets for text');
    expect(relinkAccepts('a/Note.MD', text)).toBe(true);
    expect(relinkAccepts('a/Note.txt', text)).toBe(false);
    expect(relinkAccepts('.md', text)).toBe(false);
    expect(relinkTargetsLabel(text)).toBe('a md / markdown file');
    expect(relinkTargets('link')).toBeNull();
  });
});
