/**
 * What the toolbar's save indicator shows for each save state. Every state
 * has its own icon as well as its own colour, so it never relies on colour
 * alone. The colours are themed tokens that each built-in theme keeps at 3:1
 * or better against `--toolbar-bg`; the accent fallback covers a custom theme
 * that doesn't define them.
 */
import type { SaveState } from '../../stores/saveState.svelte';

export type SaveIndicatorIcon = 'check-circle' | 'spinner' | 'alert-circle' | 'help-circle';

export interface SaveIndicatorView {
  icon: SaveIndicatorIcon;
  /** CSS colour value for the icon. */
  color: string;
  /** Tooltip text. */
  label: string;
  /** Only a failure or a waiting decision opens something (the save popover). */
  clickable: boolean;
}

export function saveIndicatorView(state: SaveState): SaveIndicatorView {
  switch (state) {
    case 'saving':
      return {
        icon: 'spinner',
        color: 'var(--toolbar-save-busy, var(--accent-warning))',
        label: 'Saving…',
        clickable: false,
      };
    case 'error':
      return {
        icon: 'alert-circle',
        color: 'var(--toolbar-save-error, var(--accent-danger))',
        label: 'Save failed — click for details',
        clickable: true,
      };
    case 'attention':
      return {
        icon: 'help-circle',
        color: 'var(--toolbar-save-attention, var(--accent-info))',
        label: 'Waiting for your decision — click for details',
        clickable: true,
      };
    case 'saved':
      return {
        icon: 'check-circle',
        color: 'var(--toolbar-save-ok, var(--accent-success))',
        label: 'All changes saved',
        clickable: false,
      };
  }
}
