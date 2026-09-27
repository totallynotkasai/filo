import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * The vault name lives on the project, not in `settings.general`, so the
 * `app.json` write must be handed it. Otherwise the name loaded at open
 * (carried in the general slice's passthrough keys) is written back and a
 * rename is lost on reopen.
 */
describe('app.json carries the vault name', () => {
  let saved: Map<string, unknown>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    saved = new Map();
    installFiloMock({
      'config:save': (...args: unknown[]) => {
        saved.set(String(args[1]), args[2]);
        return null;
      },
      'config:save-workspace': () => null,
    });
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('writes the renamed name over the one loaded at open', async () => {
    const settings = { general: { name: 'Old Name' } } as unknown as ProjectSettings;
    const workspace = { openTabs: [], activeTabId: '' } as WorkspaceState;

    await writeConfigs('/vault-name-test', settings, 'light', workspace, undefined, 'New Name');

    const raw = saved.get('app.json');
    const app = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { name?: string };
    expect(app.name).toBe('New Name');
  });
});
