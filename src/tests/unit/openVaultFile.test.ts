import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openVaultFileExternally } from '@renderer/lib/utils/openVaultFile';
import { uiStore } from '@renderer/stores/ui.svelte';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

describe('openVaultFileExternally — FileTile open', () => {
  let invoke: ReturnType<typeof vi.fn<Invoke>>;
  let pushToast: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invoke = vi.fn<Invoke>(async () => ({ success: true }));
    (window as unknown as { filo: { invoke: Invoke } }).filo = { invoke };
    pushToast = vi.spyOn(uiStore, 'pushToast').mockImplementation(() => 'toast-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastToastAction(): { label: string; handler: () => void } {
    const opts = pushToast.mock.calls.at(-1)?.[0] as { actions: { label: string; handler: () => void }[] };
    const action = opts.actions[0];
    if (!action) throw new Error('toast has no action');
    return action;
  }

  it('opens an allowlisted document through media:open-external', async () => {
    await openVaultFileExternally('C:/vault/report.pdf', 'report.pdf');
    expect(invoke).toHaveBeenCalledWith('media:open-external', 'C:/vault/report.pdf');
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a not-allowed extension never reaches the OS; the toast offers Show in folder', async () => {
    await openVaultFileExternally('C:/vault/setup.js', 'setup.js');
    expect(invoke).not.toHaveBeenCalledWith('media:open-external', expect.anything());
    expect(pushToast).toHaveBeenCalledTimes(1);
    const opts = pushToast.mock.calls[0]?.[0] as { text: string; type: string };
    expect(opts.text).toContain('".js"');
    expect(opts.type).toBe('warning');

    const action = lastToastAction();
    expect(action.label).toBe('Show in folder');
    action.handler();
    expect(invoke).toHaveBeenCalledWith('shell:show-item-in-folder', 'C:/vault/setup.js');
  });

  it('main refusing with EXTENSION_NOT_ALLOWED also offers Show in folder', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'media:open-external'
        ? { success: false, code: 'EXTENSION_NOT_ALLOWED', error: 'refused' }
        : true,
    );
    await openVaultFileExternally('C:/vault/report.pdf', 'report.pdf');
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(lastToastAction().label).toBe('Show in folder');
  });
});
