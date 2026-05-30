import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onError,
  reportError,
  __resetErrorBusForTests,
  type ReportedError,
} from '@renderer/lib/utils/errorBus';

describe('errorBus', () => {
  beforeEach(() => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('delivers the error payload to every subscribed handler', () => {
    const a: ReportedError[] = [];
    const b: ReportedError[] = [];
    onError((e) => a.push(e));
    onError((e) => b.push(e));

    const boom = new Error('boom');
    reportError('vault', boom, 'Failed to open vault');

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual({ context: 'vault', error: boom, message: 'Failed to open vault' });
  });

  it('returns an unsubscribe function that stops further deliveries', () => {
    const received: ReportedError[] = [];
    const unsubscribe = onError((e) => received.push(e));

    reportError('x', new Error('first'));
    unsubscribe();
    reportError('x', new Error('second'));

    expect(received).toHaveLength(1);
  });

  it('isolates a misbehaving subscriber from peers', () => {
    const received: ReportedError[] = [];
    onError(() => { throw new Error('subscriber bug'); });
    onError((e) => received.push(e));

    expect(() => reportError('x', new Error('y'))).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('preserves the console.error breadcrumb for devtools', () => {
    const consoleErr = vi.spyOn(console, 'error');
    reportError('vault', new Error('disk full'), 'save failed');
    expect(consoleErr).toHaveBeenCalled();
  });
});
