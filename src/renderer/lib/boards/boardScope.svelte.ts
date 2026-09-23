/**
 * BoardScope — per-pane bundle of `{ board, canvas, selection, spatial }`
 * state. Each split-pane leaf instantiates one scope so two panes can render
 * different boards independently, with independent viewports, selection, and
 * spatial indexes.
 *
 * The currently-active pane's scope is reflected through the global
 * `boardStore` / `canvasStore` / `selectionStore` / `spatialStore` facades:
 * each is a Proxy that resolves to `getActiveScope().<slice>` at every
 * property access. Workspace-level services (hotkeys, GlobalToolbar, command
 * registry) read through these facades; per-pane component trees read via
 * the Svelte context exposed under `BOARD_SCOPE_KEY`.
 *
 * This file holds the *primitives* only — types, active-scope state,
 * accessors, the facade Proxy helper, and the context key. The composer
 * (`createBoardScope`) lives in `boardScopeFactory.ts` to break the circular
 * runtime import: the four store modules import `getActiveScope` /
 * `makeFacade` from here for their global facades, so this file must NOT
 * import them at runtime. Type-only imports below are erased by the
 * compiler so they don't trigger module loading.
 */
// Runtime import — NOT one of the four store modules the circular-import
// note below guards against. `vaultLifecycle` only depends on the leaf
// `errorBus` util, so importing it here introduces no cycle back into the
// store-facade graph.
import { vaultSwapResettable } from '../../core/vaultLifecycle';
import type { createBoardScopeBoard } from '../../stores/board.svelte';
import type { createCanvasScope } from '../../stores/canvas.svelte';
import type { createSelectionScope } from '../../stores/selection.svelte';
import type { createSpatialScope } from '../../stores/spatial.svelte';

export type BoardScopeBoard = ReturnType<typeof createBoardScopeBoard>;
export type BoardScopeCanvas = ReturnType<typeof createCanvasScope>;
export type BoardScopeSelection = ReturnType<typeof createSelectionScope>;
export type BoardScopeSpatial = ReturnType<typeof createSpatialScope>;

export interface BoardScope {
  board: BoardScopeBoard;
  canvas: BoardScopeCanvas;
  selection: BoardScopeSelection;
  spatial: BoardScopeSpatial;
}

/**
 * Svelte context key for the per-pane scope. Components inside a `PaneView`
 * read their scope via `getContext(BOARD_SCOPE_KEY)`.
 */
export const BOARD_SCOPE_KEY = Symbol('boardScope');

/**
 * Default-scope factory registration. `boardScopeFactory.ts` calls
 * `setDefaultScopeFactory(createBoardScope)` at its module-load time so
 * that the lazy fallback in `getActiveScope` can build a default scope
 * before any `PaneView` mounts. Importing `boardScopeFactory.ts` from the
 * app entry point (App.svelte / a top-level store) is what wires this up.
 */
let defaultScopeFactory: (() => BoardScope) | null = null;

export function setDefaultScopeFactory(factory: () => BoardScope): void {
  defaultScopeFactory = factory;
}

/**
 * The currently-active scope. Lazily created on first `getActiveScope()`
 * call rather than eagerly at module load — eager init would race the
 * circular ESM resolution between this file and the four store modules.
 *
 * Marked `$state` so swapping the reference (`setActiveScope`) reactively
 * notifies every consumer that read through a global facade.
 */
let activeScopeRef = $state<BoardScope | null>(null);

/**
 * Plain (non-reactive) mirror of the active scope, kept purely so identity
 * comparisons survive. Assigning an object into a `$state` rune wraps it in a
 * reactive Proxy, so `getActiveScope()` returns the Proxy — never the raw
 * object a `PaneView` passed to `setContext`. `isActiveScope` compares against
 * this raw reference instead so "is my pane the active one" works by identity.
 */
let activeScopeRaw: BoardScope | null = null;

export function getActiveScope(): BoardScope {
  if (activeScopeRef === null) {
    if (!defaultScopeFactory) {
      throw new Error(
        '[boardScope] No default factory registered. ' +
        'Import `boardScopeFactory.ts` at app entry to install one.',
      );
    }
    const created = defaultScopeFactory();
    activeScopeRef = created;
    activeScopeRaw = created;
  }
  return activeScopeRef;
}

export function setActiveScope(scope: BoardScope): void {
  activeScopeRef = scope;
  activeScopeRaw = scope;
}

/**
 * Audit-7 L18 — drops the active-scope references so the next
 * `getActiveScope()` lazily rebuilds a fresh default scope.
 *
 * On vault swap `workspace.reset()` unmounts every `PaneView`, but the only
 * writer of `activeScopeRef`/`activeScopeRaw` is a mounted PaneView's
 * `setActiveScope` — so without this the outgoing vault's dead scope lingered
 * in the global facades until the new vault's first PaneView `$effect` re-ran.
 * Reads were null-safe (the dead scope's board id is absent from the new
 * cache), but any facade consumer that mutated during the swap window saw the
 * wrong vault's slice. Registered as a `pre-swap` reset below so it fires for
 * both an open-other-vault swap AND a close-to-home (`nextVault === null`).
 */
export function resetActiveScope(): void {
  activeScopeRef = null;
  activeScopeRaw = null;
}

vaultSwapResettable('boardScope', () => {
  resetActiveScope();
});

/**
 * Whether `scope` is the currently-active pane's scope, compared by raw object
 * identity (see {@link activeScopeRaw}). Board components gate their global
 * keyboard shortcuts on this so a split view routes a shared binding (e.g. the
 * bare `n` claimed by both Kanban and Task List) to the focused pane.
 */
export function isActiveScope(scope: BoardScope): boolean {
  return activeScopeRaw === scope;
}

/**
 * Shared factory for the four global facade Proxies (`boardStore`,
 * `canvasStore`, `selectionStore`, `spatialStore`). Each property access
 * delegates to whatever object `getTarget()` currently returns.
 *
 * The trap surface is broader than just `get`/`set` so that
 * `vi.spyOn(facade, 'method').mockImplementation(...)` works in tests:
 * vitest's spy first reads the property descriptor and then calls
 * `Object.defineProperty` to install the spy. Without
 * `getOwnPropertyDescriptor` + `defineProperty` traps, the Proxy returns
 * `undefined` for the descriptor (looking at the empty target) and the
 * spy install throws. Overrides are stored in an internal map so spies
 * coexist with the live delegation, and any redefinition takes precedence
 * on subsequent `get`s.
 */
export function makeFacade<T extends object>(getTarget: () => T): T {
  const overrides: Record<string | symbol, unknown> = Object.create(null) as Record<string | symbol, unknown>;
  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    has(_t, prop) {
      if (prop in overrides) return true;
      const target = getTarget();
      return prop in target;
    },
    get(_t, prop) {
      if (prop in overrides) {
        return overrides[prop];
      }
      const target = getTarget();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_t, prop, value) {
      overrides[prop] = value;
      return true;
    },
    deleteProperty(_t, prop) {
      delete overrides[prop];
      return true;
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (prop in overrides) {
        return { value: overrides[prop], writable: true, enumerable: true, configurable: true };
      }
      const target = getTarget();
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc) {
        if (desc.get) {
          return {
            value: desc.get.call(target),
            writable: true, enumerable: true, configurable: true,
          };
        }
        return { ...desc, configurable: true };
      }
      // Methods may live on the prototype (e.g. class-based SpatialScope).
      const proto = Reflect.getPrototypeOf(target);
      if (proto) {
        const pdesc = Reflect.getOwnPropertyDescriptor(proto, prop);
        if (pdesc) return { ...pdesc, configurable: true };
      }
      return undefined;
    },
    defineProperty(_t, prop, descriptor) {
      if ('value' in descriptor) {
        overrides[prop] = descriptor.value;
      } else if (descriptor.get) {
        overrides[prop] = descriptor.get();
      }
      return true;
    },
    ownKeys(_t) {
      // Plain dedupe via object keys, not Set — the lint rule
      // `svelte/prefer-svelte-reactivity` forbids the built-in Set in
      // renderer code, and there's no reactive aspect to a Proxy ownKeys
      // trap (it runs synchronously per Reflect.ownKeys call).
      const seen: Record<string, true> = Object.create(null) as Record<string, true>;
      const out: Array<string | symbol> = [];
      for (const k of Reflect.ownKeys(getTarget())) {
        const key = typeof k === 'symbol' ? k.toString() : k;
        if (!seen[key]) { seen[key] = true; out.push(k); }
      }
      for (const k of Reflect.ownKeys(overrides)) {
        const key = typeof k === 'symbol' ? k.toString() : k;
        if (!seen[key]) { seen[key] = true; out.push(k); }
      }
      return out;
    },
  });
  return proxy as unknown as T; // allow-cast: facade Proxy resolves to T at access time
}
