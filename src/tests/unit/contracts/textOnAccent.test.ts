/**
 * Text on the theme accent uses `--text-inverse`, the theme's "Text on accent"
 * colour, which every built-in holds at 4.5:1 or better (themeContrast.test.ts).
 * Hard-coded white on the accent reads at about 2:1 in Retro, Nature and
 * Blueprint, whose accents are light.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function styleFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'tests') styleFiles(path, out);
    } else if (/\.(svelte|css)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Rules (`selector { body }`) whose background is the theme accent. */
function accentRules(text: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2] ?? '';
    const onAccent = /background(?:-color)?:\s*var\(--accent-primary(?:-hover)?\s*[,)]/.test(body)
      || (/background(?:-color)?:\s*var\(--accent\)/.test(body));
    if (onAccent) rules.push({ selector: (m[1] ?? '').trim().split('\n').pop() ?? '', body });
  }
  return rules;
}

describe('text on the accent', () => {
  const files = styleFiles(SRC);

  it('is never a hard-coded white', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { selector, body } of accentRules(readFileSync(file, 'utf8'))) {
        const colour = /(?:^|[;\s])color:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
        if (/^(white|#fff|#ffffff)$/i.test(colour)) offenders.push(`${relative(SRC, file)}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never names --accent-on-primary, which no theme defines', () => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('--accent-on-primary'));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
