/**
 * Vitest global setup — runs once before each test file in this directory.
 *
 * jsdom does not implement `PointerEvent`. Several modules under test
 * construct PointerEvents directly (`new PointerEvent(...)`) — e.g. the
 * `taskDragController` synthesises a pointerup when ESC cancels a drag.
 * Polyfilling against `MouseEvent` gives jsdom a constructible PointerEvent
 * that preserves the `clientX` / `clientY` / `pointerType` / `target` fields
 * the test surfaces care about.
 *
 * A silent default `window.filo` stub is installed before every test so that
 * debounced write paths (e.g. `markDirty` from boardSaver) don't emit
 * `[dirtyFlag] Failed to mark dirty: TypeError` noise from tests that don't
 * care about IPC. Tests that need to assert specific channel calls install
 * their own via `installFiloMock` from `tests/helpers/filoBridge`.
 */

// Eager side-effect import registers the BoardScope composer so that the
// global facade Proxies (boardStore / canvasStore / selectionStore /
// spatialStore) can lazily build a default scope on first access. Tests
// import these facades directly; without this registration, the lazy
// fallback in `getActiveScope` would throw.
import '../renderer/lib/boards/boardScopeFactory';

import { beforeEach } from 'vitest';
import { installFiloDefault } from './helpers/filoBridge';
import { __setMachineIdentityForTests } from '../renderer/lib/vault/machineIdentity';
import { TEST_MACHINE_IDENTITY } from './helpers/testMachine';

// Audit-19 EXT-5 — main's Windows lock retry is time-bounded (~5 s on win32).
// Pin the legacy ~310 ms budget so suites that force a PERMANENT lock don't each
// stall for 5 s; tests of the long budget set/clear this themselves.
// Main's code runs only under Node; the browser project (real Chromium) has no `process`.
if (typeof process !== 'undefined') process.env.FILO_LOCK_RETRY_BUDGET_MS = '310';

// Audit-19 EXT-6 — crash sentinels are per machine; pin a fixed identity so
// suites that touch them (and the vault-open path) name a stable file.
__setMachineIdentityForTests(TEST_MACHINE_IDENTITY);

if (typeof globalThis.PointerEvent === 'undefined') {
  class JsDomPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    width: number;
    height: number;
    pressure: number;
    tangentialPressure: number;
    tiltX: number;
    tiltY: number;
    twist: number;
    isPrimary: boolean;

    constructor(type: string, props: PointerEventInit = {}) {
      super(type, props);
      this.pointerId = props.pointerId ?? 0;
      this.pointerType = props.pointerType ?? 'mouse';
      this.width = props.width ?? 1;
      this.height = props.height ?? 1;
      this.pressure = props.pressure ?? 0;
      this.tangentialPressure = props.tangentialPressure ?? 0;
      this.tiltX = props.tiltX ?? 0;
      this.tiltY = props.tiltY ?? 0;
      this.twist = props.twist ?? 0;
      this.isPrimary = props.isPrimary ?? true;
    }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    JsDomPointerEvent as unknown as typeof PointerEvent;
}

beforeEach(() => {
  installFiloDefault();
});
