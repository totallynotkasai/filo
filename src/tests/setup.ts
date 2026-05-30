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
