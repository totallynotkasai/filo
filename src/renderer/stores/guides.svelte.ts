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

// Drop any guide overlays on vault swap: the swap can land mid-drag (e.g. a
// keyboard shortcut during pointer capture), and the guides would otherwise
// linger over the new vault's canvas until the next drag-end.
onVaultSwap('pre-swap', 'guides', () => {
  activeGuides = [];
});
