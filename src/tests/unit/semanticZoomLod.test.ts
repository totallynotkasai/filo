import { describe, it, expect } from 'vitest';
import { CANVAS_DEFAULTS } from '@renderer/constants/defaults';

/**
 * Semantic zoom (LOD) thresholds — V1.0 plan §2.2.
 *
 * The canvas store derives `lodLevel` from `transform.scale` against these two
 * thresholds. Locking the constants keeps the rendering tiers ('full' /
 * 'simplified' / 'block') stable across refactors.
 */

function lodLevel(scale: number, enabled = true): 'full' | 'simplified' | 'block' {
  if (!enabled) return 'full';
  if (scale < CANVAS_DEFAULTS.semanticZoomBlockThreshold) return 'block';
  if (scale < CANVAS_DEFAULTS.semanticZoomThreshold) return 'simplified';
  return 'full';
}

describe('semantic zoom LOD thresholds', () => {
  it('exposes the 50% / 25% thresholds in CANVAS_DEFAULTS', () => {
    expect(CANVAS_DEFAULTS.semanticZoomThreshold).toBe(0.5);
    expect(CANVAS_DEFAULTS.semanticZoomBlockThreshold).toBe(0.25);
  });

  it('returns "full" at 100% zoom', () => {
    expect(lodLevel(1)).toBe('full');
  });

  it('returns "full" exactly at the 50% threshold (inclusive)', () => {
    expect(lodLevel(0.5)).toBe('full');
  });

  it('returns "simplified" between 25% and 50% zoom', () => {
    expect(lodLevel(0.49)).toBe('simplified');
    expect(lodLevel(0.3)).toBe('simplified');
    expect(lodLevel(0.25)).toBe('simplified');
  });

  it('returns "block" below 25% zoom', () => {
    expect(lodLevel(0.24)).toBe('block');
    expect(lodLevel(0.1)).toBe('block');
  });

  it('returns "full" at any zoom when semantic zoom is disabled', () => {
    expect(lodLevel(0.1, false)).toBe('full');
    expect(lodLevel(0.4, false)).toBe('full');
  });
});

describe('connection visibility cycle (V1.0 plan §2.1)', () => {
  type Visibility = 'visible' | 'hidden' | 'visible-locked' | 'hidden-locked';
  const states: Visibility[] = ['visible', 'hidden', 'visible-locked', 'hidden-locked'];

  function nextState(current: Visibility): Visibility {
    const idx = states.indexOf(current);
    return states[(idx + 1) % states.length] ?? 'visible';
  }

  it('cycles visible → hidden → visible-locked → hidden-locked → visible', () => {
    expect(nextState('visible')).toBe('hidden');
    expect(nextState('hidden')).toBe('visible-locked');
    expect(nextState('visible-locked')).toBe('hidden-locked');
    expect(nextState('hidden-locked')).toBe('visible');
  });
});
