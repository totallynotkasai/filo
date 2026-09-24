import { describe, it, expect, beforeEach, vi } from 'vitest';

const showMessageBox = vi.fn();
vi.mock('electron', () => ({
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
}));

const { attachRendererCrashHandlers, isRendererGone, __resetRendererCrashStateForTests } = await import(
  '../../main/services/rendererCrashHandler'
);

type Listener = (...args: unknown[]) => void;

function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const webContents = {
    on: (event: string, cb: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      return webContents;
    },
    reload: vi.fn(),
  };
  const win = { webContents, isDestroyed: vi.fn(() => false), destroy: vi.fn() };
  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };
  return { win, emit };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('renderer crash handling', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetRendererCrashStateForTests();
    showMessageBox.mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => errSpy.mockRestore();
  });

  function attach(isQuitting = false) {
    const { win, emit } = fakeWindow();
    const writeBreadcrumb = vi.fn(async () => {});
    attachRendererCrashHandlers(win as never, { writeBreadcrumb, isQuitting: () => isQuitting });
    return { win, emit, writeBreadcrumb };
  }

  it('render-process-gone (oom) → breadcrumb written, dialog shown; Reload reloads', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    const { win, emit, writeBreadcrumb } = attach();
    emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
    expect(isRendererGone()).toBe(true);
    await settle();
    expect(writeBreadcrumb).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ buttons: ['Reload', 'Quit'] });
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();

    emit('did-finish-load');
    expect(isRendererGone()).toBe(false);
  });

  it('Quit destroys the window', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    const { win, emit } = attach();
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('a crash during a quit drain closes without asking', async () => {
    const { win, emit } = attach(true);
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it('clean-exit is ignored', async () => {
    const { emit, writeBreadcrumb } = attach();
    emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await settle();
    expect(isRendererGone()).toBe(false);
    expect(writeBreadcrumb).not.toHaveBeenCalled();
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('unresponsive is logged only', async () => {
    const { win, emit } = attach();
    emit('unresponsive');
    await settle();
    expect(isRendererGone()).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });
});
