/**
 * `window.filo` wired to the real main-process handlers.
 *
 * Mirrors the preload: every invoke is validated with `validateIpcPayload`,
 * arguments and results are structured-cloned (as Electron's IPC does, so a
 * renderer that hands a live proxy to IPC fails here too), and main's pushes
 * reach the listeners registered through `window.filo.on`.
 *
 * One bridge per test file: the app subscribes once, and the shared test setup
 * swaps `window.filo` for a silent stub before every test, so `attach()` puts
 * this same object back.
 */
import { validateIpcPayload } from '@shared/ipcSchemas';
import { registerAllHandlers } from '../../../main/ipc/index';
import { mainHandlers, mainListeners, rendererSink } from './electronFake';

export interface IpcCall {
  channel: string;
  args: unknown[];
}

export interface MainBridge {
  /** Every invoke since the last `resetLog()`, in call order. */
  calls: IpcCall[];
  /** Invokes still waiting on main. */
  inFlight(): number;
  resetLog(): void;
  /** (Re)install this bridge as `window.filo`. */
  attach(): void;
  /** Holds every read of `rel` (`vault:read-file-text`), as a slow disk would, until let go. */
  holdReads(rel: string): ReadHold;
}

export interface ReadHold {
  /** Reads held so far (including ones let go). */
  count(): number;
  /** Lets every held read go except the newest. */
  releaseEarlier(): void;
  /** Lets the newest held read go (holding continues for later reads). */
  releaseNewest(): void;
  /** Lets every held read go and stops holding. */
  release(): void;
}

let bridge: MainBridge | null = null;

export function mainBridge(): MainBridge {
  if (bridge) return bridge;
  registerAllHandlers();

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls: IpcCall[] = [];
  let pending = 0;
  let held: { rel: string; waiting: Array<() => void>; count: number } | null = null;
  const sender = { id: 1, send: (channel: string, ...args: unknown[]) => rendererSink.send(channel, ...args) };

  rendererSink.send = (channel, ...args) => {
    for (const cb of listeners.get(channel) ?? []) cb(...structuredClone(args));
  };

  const filo = {
    systemLocale: 'en-GB',
    getPathForFile: () => '',
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const validation = validateIpcPayload(channel, args);
      if (!validation.ok) throw new Error(`Invalid IPC payload for ${channel}: ${validation.error}`);
      const handler = mainHandlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      calls.push({ channel, args });
      pending++;
      try {
        const result = await handler({ sender }, ...structuredClone(args));
        const hold = held;
        if (hold && channel === 'vault:read-file-text' && args[1] === hold.rel) {
          hold.count++;
          await new Promise<void>((go) => hold.waiting.push(go));
        }
        return result === undefined ? undefined : structuredClone(result);
      } finally {
        pending--;
      }
    },
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb);
      listeners.set(channel, set);
      return () => {
        set.delete(cb);
      };
    },
    send: (channel: string, ...args: unknown[]) => {
      for (const l of mainListeners.get(channel) ?? []) l({ sender }, ...structuredClone(args));
    },
  };

  bridge = {
    calls,
    inFlight: () => pending,
    resetLog: () => {
      calls.length = 0;
    },
    attach: () => {
      (window as unknown as { filo: unknown }).filo = filo;
    },
    holdReads: (rel) => {
      const hold = { rel, waiting: [] as Array<() => void>, count: 0 };
      held = hold;
      return {
        count: () => hold.count,
        releaseEarlier: () => {
          for (const go of hold.waiting.splice(0, Math.max(0, hold.waiting.length - 1))) go();
        },
        releaseNewest: () => {
          hold.waiting.pop()?.();
        },
        release: () => {
          if (held === hold) held = null;
          for (const go of hold.waiting.splice(0)) go();
        },
      };
    },
  };
  bridge.attach();
  return bridge;
}
