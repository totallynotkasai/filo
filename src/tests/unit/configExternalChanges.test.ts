import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs, seedConfigSnapshots } from '@renderer/lib/boards/configWriteScheduler';
import { setConfigExternalHandlers, type ConfigDriftChoice } from '@renderer/lib/boards/configDrift';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * A `.filo/` config changed or deleted outside Filo never blocks its saves for
 * the rest of the session: Filo's own bytes are taken silently, layout state
 * is written over after a copy, settings ask Reload / Keep local, and a
 * deleted file is created again.
 */

const VAULT = '/vault';
const workspace: WorkspaceState = { openTabs: [], activeTabId: '' };
const layout = (sidebarWidth: number) => ({ paneTree: null, activePaneId: null, sidebarWidth, kanbanToolbar: null });
const settingsWith = (mindmap: Record<string, unknown>): ProjectSettings =>
  ({ general: { globalFont: 'fixed' }, mindmap, kanban: {}, tasklist: {}, document: {} } as ProjectSettings);

interface Call { channel: string; args: unknown[] }

/**
 * A vault whose config files are all on disk at stat (1000, 50) except the
 * ones `disk` names: those were changed outside Filo (stat 2000, 60) and read
 * back as the given object, or deleted (`null`).
 */
function mockVault(disk: Record<string, Record<string, unknown> | null>, calls: Call[]): void {
  // Files Filo writes get a fresh stamp and read back as written.
  const stamps = new Map<string, { mtimeMs: number; size: number }>();
  const written = new Map<string, unknown>();
  let clock = 3000;
  const deleted = new Set(Object.entries(disk).filter(([, v]) => v === null).map(([k]) => k));
  installFiloMock((channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel === 'vault:stat') {
      const file = String(args[1]).replace('.filo/', '');
      if (deleted.has(file)) return { ok: false, code: 'ENOENT', error: 'gone' };
      const stamp = stamps.get(file);
      if (stamp) return { ok: true, ...stamp };
      return file in disk ? { ok: true, mtimeMs: 2000, size: 60 } : { ok: true, mtimeMs: 1000, size: 50 };
    }
    if (channel === 'config:load') {
      const file = String(args[1]);
      return written.has(file) ? written.get(file) : (disk[file] ?? {});
    }
    if (channel === 'recovery:snapshot') return { ok: true, path: `${VAULT}/.filo/recovery/x-keep/y` };
    if (channel === 'config:save' || channel === 'config:save-workspace') {
      const file = channel === 'config:save' ? String(args[1]) : 'workspace.json';
      const payload = String(channel === 'config:save' ? args[2] : args[1]);
      deleted.delete(file);
      written.set(file, JSON.parse(payload));
      stamps.set(file, { mtimeMs: ++clock, size: new TextEncoder().encode(payload).length });
      return { ok: true };
    }
    return undefined;
  });
}

function saves(calls: Call[], file: string): Call[] {
  return calls.filter((c) =>
    file === 'workspace.json'
      ? c.channel === 'config:save-workspace' || (c.channel === 'config:save' && c.args[1] === file)
      : c.channel === 'config:save' && c.args[1] === file);
}

function handlers(choice: ConfigDriftChoice) {
  const log = { prompts: [] as string[], reloads: [] as Array<[string, unknown]>, notices: [] as string[] };
  setConfigExternalHandlers({
    prompt: async (file) => {
      log.prompts.push(file);
      return choice;
    },
    reload: (file, obj) => {
      log.reloads.push([file, obj]);
      return true;
    },
    notice: (_key, text) => log.notices.push(text),
  });
  return log;
}

describe('config files changed outside Filo', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    for (const f of ['app.json', 'defaults.json', 'appearance.json', 'workspace.json']) noteBaseline(`.filo/${f}`, 1000, 50);
    seedConfigSnapshots(settingsWith({ x: 1 }), 'light', workspace, layout(260));
  });
  afterEach(() => {
    setConfigExternalHandlers(null);
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  it("a new stamp on Filo's own bytes: the baseline moves on and the write goes ahead, no prompt", async () => {
    const log = handlers('defer');
    const calls: Call[] = [];
    mockVault({ 'defaults.json': { mindmap: { x: 1 }, kanban: {}, tasklist: {}, document: {} } }, calls);
    const result = await writeConfigs(VAULT, settingsWith({ x: 2 }), 'light', workspace, layout(260));
    expect(result.failed).toEqual([]);
    expect(saves(calls, 'defaults.json')).toHaveLength(1);
    expect(log.prompts).toEqual([]);

    // And the next change is not blocked either.
    calls.length = 0;
    const again = await writeConfigs(VAULT, settingsWith({ x: 3 }), 'light', workspace, layout(260));
    expect(again.failed).toEqual([]);
    expect(saves(calls, 'defaults.json')).toHaveLength(1);
  });

  it('layout changed outside Filo: a copy first, then Filo writes its layout, with one notice', async () => {
    const log = handlers('defer');
    const calls: Call[] = [];
    mockVault({ 'workspace.json': { openTabs: [{ id: 't', boardId: 'b' }], activeTabId: 't' } }, calls);
    const result = await writeConfigs(VAULT, settingsWith({ x: 1 }), 'light', workspace, layout(300));
    expect(result.failed).toEqual([]);
    const snap = calls.findIndex((c) => c.channel === 'recovery:snapshot');
    const write = calls.findIndex((c) => c.channel === 'config:save-workspace');
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(calls[snap]?.args).toEqual([VAULT, '.filo/workspace.json', 'keep']);
    expect(write).toBeGreaterThan(snap);
    expect(log.prompts).toEqual([]);
    expect(log.notices).toHaveLength(1);
  });

  it('settings changed outside Filo, Keep local: a copy first, then the write; later saves go through', async () => {
    const log = handlers('keep-local');
    const calls: Call[] = [];
    mockVault({ 'defaults.json': { mindmap: { theirs: true }, kanban: {}, tasklist: {}, document: {} } }, calls);
    const result = await writeConfigs(VAULT, settingsWith({ x: 2 }), 'light', workspace, layout(260));
    expect(result.failed).toEqual([]);
    expect(log.prompts).toEqual(['defaults.json']);
    const snap = calls.findIndex((c) => c.channel === 'recovery:snapshot');
    expect(calls[snap]?.args).toEqual([VAULT, '.filo/defaults.json', 'keep']);
    expect(calls.findIndex((c) => c.channel === 'config:save' && c.args[1] === 'defaults.json')).toBeGreaterThan(snap);

    calls.length = 0;
    const again = await writeConfigs(VAULT, settingsWith({ x: 3 }), 'light', workspace, layout(260));
    expect(again.failed).toEqual([]);
    expect(saves(calls, 'defaults.json')).toHaveLength(1);
    expect(log.prompts).toEqual(['defaults.json']);
  });

  it("settings changed outside Filo, Reload: Filo takes the file's settings and writes nothing over it", async () => {
    const log = handlers('reload');
    const calls: Call[] = [];
    const theirs = { mindmap: { theirs: true }, kanban: {}, tasklist: {}, document: {} };
    mockVault({ 'defaults.json': theirs }, calls);
    const result = await writeConfigs(VAULT, settingsWith({ x: 2 }), 'light', workspace, layout(260));
    expect(result.failed).toEqual([]);
    expect(log.reloads).toEqual([['defaults.json', theirs]]);
    expect(saves(calls, 'defaults.json')).toHaveLength(0);
  });

  it('settings changed outside Filo, prompt dismissed: nothing written, reported, and asked again next time', async () => {
    const log = handlers('defer');
    const calls: Call[] = [];
    const theirs = { mindmap: { theirs: true }, kanban: {}, tasklist: {}, document: {} };
    mockVault({ 'defaults.json': theirs }, calls);
    const result = await writeConfigs(VAULT, settingsWith({ x: 2 }), 'light', workspace, layout(260));
    expect(result.failed).toEqual(['defaults.json']);
    expect(result.error).toBeUndefined();
    expect(saves(calls, 'defaults.json')).toHaveLength(0);

    await writeConfigs(VAULT, settingsWith({ x: 3 }), 'light', workspace, layout(260));
    expect(log.prompts).toEqual(['defaults.json', 'defaults.json']);
  });

  it('a deleted config is created again, exclusively, with a notice', async () => {
    const log = handlers('defer');
    const calls: Call[] = [];
    mockVault({ 'app.json': null }, calls);
    const settings = { ...settingsWith({ x: 1 }), general: { globalFont: 'changed' } } as ProjectSettings;
    const result = await writeConfigs(VAULT, settings, 'light', workspace, layout(260));
    expect(result.failed).toEqual([]);
    const created = saves(calls, 'app.json');
    expect(created).toHaveLength(1);
    expect(created[0]?.args[3]).toEqual({ createOnly: true });
    expect(log.notices.some((n) => n.includes('.filo/app.json was deleted outside Filo and has been recreated'))).toBe(true);
  });

  it('a copy that came back while Filo recreated it is not overwritten', async () => {
    handlers('defer');
    const calls: Call[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:stat') {
        return String(args[1]) === '.filo/app.json' ? { ok: false, code: 'ENOENT', error: 'gone' } : { ok: true, mtimeMs: 1000, size: 50 };
      }
      if (channel === 'config:save' && args[1] === 'app.json') return { ok: false, code: 'EEXIST', error: 'exists' };
      if (channel === 'config:save' || channel === 'config:save-workspace') return { ok: true };
      return undefined;
    });
    const settings = { ...settingsWith({ x: 1 }), general: { globalFont: 'changed' } } as ProjectSettings;
    const result = await writeConfigs(VAULT, settings, 'light', workspace, layout(260));
    expect(result.failed).toEqual(['app.json']);
    expect(saves(calls, 'app.json')).toHaveLength(1);
  });
});
