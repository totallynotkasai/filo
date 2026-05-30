import type { Guide } from '../lib/canvas/smartGuides';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Smart guides store — tracks active alignment guides shown during tile drag.
 * Snap enabled state is owned by canvasStore.snapEnabled.
 */

let activeGuides = $state<Guide[]>([]);

export const guidesStore = {
  get guides() { return activeGuides; },

  setGuides(guides: Guide[]) {
    activeGuides = guides;
  },

  clear() {
    activeGuides = [];
  },
};

// Sprint B / B14 — drop any in-flight guide overlays on vault swap so the
// new vault doesn't open with the prior vault's alignment guides still
// painted over the canvas. The drag handlers that own these guides will
// clear them on the next drag-end, but the swap can land mid-drag (e.g.
// keyboard shortcut while a pointer-capture is active) and the guides
// would otherwise linger until the next drag.
onVaultSwap('pre-swap', 'guides', () => {
  activeGuides = [];
});
