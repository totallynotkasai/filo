import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio } from '@renderer/lib/utils/color';
import { THEME_TOKEN_NAMES } from '@renderer/lib/themes/themeTokens';

// WCAG AA threshold for normal-size body text.
const WCAG_AA_NORMAL = 4.5;
// WCAG AA threshold for "large" text (18pt+ regular or 14pt+ bold). UI element
// borders / non-text indicators also fall under the relaxed 3:1 contrast bar.
const WCAG_AA_LARGE = 3.0;

interface ThemeDefinition {
  id: string;
  variables: Record<string, string>;
}

/**
 * Reads every built-in theme from the `[data-theme='…']` blocks in
 * `src/css/style.css`, the only place the built-in palettes live.
 */
function loadThemes(): ThemeDefinition[] {
  const css = readFileSync(resolve(process.cwd(), 'src/css/style.css'), 'utf-8');
  const out: ThemeDefinition[] = [];
  const blockRe = /\[data-theme='([a-z]+)'\]\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(blockRe)) {
    const body = (match[2] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const variables: Record<string, string> = {};
    for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (decl[1] && decl[2]) variables[decl[1]] = decl[2].trim();
    }
    out.push({ id: match[1] ?? '', variables });
  }
  return out;
}

const themes = loadThemes();

/**
 * Pairs we want to verify. Each entry is `[textVar, backgroundVar, threshold, label]`.
 * Threshold defers to WCAG_AA_NORMAL unless the pair is documented as either
 * tertiary/disabled text or a non-text indicator.
 */
const PAIRS: Array<[string, string, number, string]> = [
  ['--text-primary', '--ui-bg', WCAG_AA_NORMAL, 'primary text on app background'],
  ['--text-primary', '--ui-surface', WCAG_AA_NORMAL, 'primary text on surface'],
  ['--text-secondary', '--ui-bg', WCAG_AA_NORMAL, 'secondary text on app background'],
  ['--text-secondary', '--ui-surface', WCAG_AA_NORMAL, 'secondary text on surface'],
  // Tertiary text is used for hints, counts, dates — small but still informational.
  // WCAG AA Large (3:1) is the appropriate bar for these supporting strings.
  ['--text-tertiary', '--ui-bg', WCAG_AA_LARGE, 'tertiary text on app background'],
  ['--accent-primary', '--ui-bg', WCAG_AA_LARGE, 'accent on background (UI indicator)'],
  ['--accent-danger', '--ui-bg', WCAG_AA_LARGE, 'danger on background (UI indicator)'],
  // Priority dots/borders on Kanban + Task List cards. Non-text indicators —
  // the relaxed 3:1 bar applies. Cards sit on `--ui-surface`, not `--ui-bg`,
  // so we measure against the surface variable.
  ['--priority-urgent', '--ui-surface', WCAG_AA_LARGE, 'priority-urgent on card surface'],
  ['--priority-high', '--ui-surface', WCAG_AA_LARGE, 'priority-high on card surface'],
  ['--priority-medium', '--ui-surface', WCAG_AA_LARGE, 'priority-medium on card surface'],
  ['--priority-low', '--ui-surface', WCAG_AA_LARGE, 'priority-low on card surface'],
  // The toolbar's save indicator: colour carries the state (an icon too), so
  // each colour must read against the toolbar.
  ['--toolbar-save-ok', '--toolbar-bg', WCAG_AA_LARGE, 'save indicator "saved" on toolbar'],
  ['--toolbar-save-busy', '--toolbar-bg', WCAG_AA_LARGE, 'save indicator "saving" on toolbar'],
  ['--toolbar-save-error', '--toolbar-bg', WCAG_AA_LARGE, 'save indicator "failed" on toolbar'],
  ['--toolbar-save-attention', '--toolbar-bg', WCAG_AA_LARGE, 'save indicator "waiting for a decision" on toolbar'],
  // The warning banner over a read-only or conflicted note.
  ['--ui-warn-text', '--ui-warn-bg', WCAG_AA_NORMAL, 'warning banner text'],
  ['--ui-warn-text', '--ui-warn-bg-hover', WCAG_AA_NORMAL, 'warning banner text (hover)'],
];

describe('built-in themes', () => {
  it('are all five read from style.css', () => {
    expect(themes.map((t) => t.id).sort()).toEqual(['blueprint', 'dark', 'light', 'nature', 'retro']);
  });

  for (const theme of themes) {
    it(`${theme.id} defines every theme token`, () => {
      const missing = THEME_TOKEN_NAMES.filter((name) => !theme.variables[name]);
      expect(missing).toEqual([]);
    });
  }
});

describe('WCAG AA contrast — built-in themes', () => {
  for (const theme of themes) {
    describe(theme.id, () => {
      for (const [textVar, bgVar, threshold, label] of PAIRS) {
        it(`${label} meets ${threshold}:1`, () => {
          const text = theme.variables[textVar];
          const bg = theme.variables[bgVar];
          expect(text, `${theme.id} missing ${textVar}`).toBeTruthy();
          expect(bg, `${theme.id} missing ${bgVar}`).toBeTruthy();
          const ratio = contrastRatio(text, bg);
          // Report the raw ratio in the failure message so an audit reader can
          // see "how far below" without re-running the failure interactively.
          expect(
            ratio,
            `[${theme.id}] ${textVar} on ${bgVar} = ${ratio.toFixed(2)}:1 (need ${threshold}:1)`,
          ).toBeGreaterThanOrEqual(threshold);
        });
      }
    });
  }
});
