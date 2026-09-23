import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  syncConnectionEdgePan,
  getEdgePanScope,
  stopEdgePan,
} from '@renderer/lib/canvas/edgePan';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';

/**
 * Audit 5.2 — edge-pan during connection drawing must arm for the pane the
 * user is drawing in, not whichever pane's effect happens to fire first.
 *
 * `connectionsStore.drawing` is a GLOBAL `$state`, so in split view both
 * mounted MindMapBoards' edge-pan effects fire on its transition. Edge-pan is a
 * module singleton armed first-caller-wins, so without a gate the first-mounted
 * (possibly inactive) pane pins its scope and edge-pan scrolls the wrong
 * canvas. `syncConnectionEdgePan` gates arming on the active pane — and a
 * connection draw always activates its pane first (PaneView capture-phase
 * pointerdown), so the drawing pane is the active one.
 */

function fakeScope(id: string): CanvasScope {
  // Identity is all that matters here — tick() (which would call panBy) never
  // runs because we don't drive requestAnimationFrame in jsdom. The `id` only
  // makes assertion diffs legible.
  return { id } as unknown as CanvasScope;
}

describe('edge-pan connection-draw scope gating (audit 5.2)', () => {
  beforeEach(() => stopEdgePan());
  afterEach(() => stopEdgePan());

  it('arms edge-pan for the ACTIVE pane regardless of effect order', () => {
    const paneA = fakeScope('A'); // first-mounted (left) pane — inactive
    const paneB = fakeScope('B'); // active pane — the user is drawing here

    // Both panes' effects fire on the global drawing transition, in mount
    // order: the inactive first-mounted pane runs before the active one.
    syncConnectionEdgePan(paneA, true, /* isActivePane */ false);
    syncConnectionEdgePan(paneB, true, /* isActivePane */ true);

    expect(getEdgePanScope()).toBe(paneB);
  });

  it('an inactive pane never pins or cancels the active pane (reverse order)', () => {
    const paneA = fakeScope('A'); // inactive
    const paneB = fakeScope('B'); // active, draws first

    syncConnectionEdgePan(paneB, true, true);
    syncConnectionEdgePan(paneA, true, false);

    expect(getEdgePanScope()).toBe(paneB);
  });

  it('single pane arms and then stops when drawing ends', () => {
    const pane = fakeScope('solo');
    syncConnectionEdgePan(pane, true, true);
    expect(getEdgePanScope()).toBe(pane);
    syncConnectionEdgePan(pane, false, true);
    expect(getEdgePanScope()).toBeNull();
  });
});
