/**
 * Shared `window.filo` test bridge.
 *
 * Two layers:
 *
 * 1. A fail-safe default stub auto-installed by `src/tests/setup.ts` before
 *    every test. `invoke` returns `undefined`; `on` returns a no-op
 *    unsubscribe; `send` is a no-op. This keeps unrelated tests silent when
 *    debounced write paths (e.g. `markDirty` in dirtyFlagRecovery.ts) fire
 *    incidentally.
 *
 * 2. Opt-in `installFiloMock(...)` for tests that need to assert specific
 *    channel calls. Two shapes:
 *      - `installFiloMock({ 'vault:write-file-text': handler, ... })` —
 *        routed; unrouted channels fall through to the silent default
 *        (return `undefined`). Routes are *additive* assertion points, not
 *        an allowlist — incidental channels fired by background save paths
 *        (e.g. `markDirty` / `markClean`) stay silent.
 *      - `installFiloMock(catchallHandler)` — single function handles every
 *        channel (matches the previous `dirtyFlagRecovery.test.ts` recorder
 *        shape). Closure form lets the test mutate the underlying handler
 *        without reinstalling.
 *
 * Always call `restoreFiloDefault()` in `afterEach` if your test installed a
 * mock — keeps state from leaking across test files.
 */

export type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

type FiloLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  send: (channel: string, ...args: unknown[]) => void;
};

function noOpOn(): () => void {
  return () => {};
}

function noOpSend(): void {
  // no-op
}

function setFilo(filo: FiloLike): void {
  (window as unknown as Record<string, unknown>).filo = filo;
}

function buildRoutedInvoke(
  routes: Record<string, InvokeHandler>,
): FiloLike['invoke'] {
  return async (channel, ...args) => {
    const handler = routes[channel];
    if (!handler) return undefined;
    return handler(...args);
  };
}

function buildCatchallInvoke(handler: InvokeHandler): FiloLike['invoke'] {
  return async (channel, ...args) => handler(channel, ...args);
}

/**
 * Installs the silent no-op default. Called automatically by setup.ts before
 * each test; exposed so tests can re-assert the default mid-test if needed.
 */
export function installFiloDefault(): void {
  setFilo({
    invoke: async () => undefined,
    on: noOpOn,
    send: noOpSend,
  });
}

/**
 * Routed install. Unrouted channels fall through to the silent default —
 * routes are assertion points, not an allowlist. This keeps incidental
 * background save channels (markDirty/markClean) from polluting stderr
 * with `[dirtyFlag] Failed to mark dirty` warnings.
 */
export function installFiloMock(
  routes: Record<string, InvokeHandler>,
): () => void;

/**
 * Catchall install. Single handler receives every channel call. Use when
 * the test needs a recorder that captures every invocation.
 */
export function installFiloMock(catchall: InvokeHandler): () => void;

export function installFiloMock(
  input: Record<string, InvokeHandler> | InvokeHandler,
): () => void {
  const invoke =
    typeof input === 'function'
      ? buildCatchallInvoke(input)
      : buildRoutedInvoke(input);
  setFilo({ invoke, on: noOpOn, send: noOpSend });
  return restoreFiloDefault;
}

/**
 * Restores the silent no-op default. Idempotent — safe to call from
 * `afterEach` even if no mock was installed.
 */
export function restoreFiloDefault(): void {
  installFiloDefault();
}
