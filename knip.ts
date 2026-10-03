import type { KnipConfig } from 'knip';
import { compile, parse } from 'svelte/compiler';

interface Span {
  start: number;
  end: number;
}

interface ImportNode extends Span {
  type: 'ImportDeclaration';
  importKind?: 'type' | 'value';
  source: { value: unknown };
  specifiers: (Span & { importKind?: 'type' | 'value' })[];
}

function isImport(node: { type: string }): node is ImportNode {
  return node.type === 'ImportDeclaration';
}

/**
 * A component as knip should read it. Svelte's compiler gives its real imports
 * and exports: a markup `{#await import(…)}` counts, and a component method
 * (`export function` in the instance script, reached through `bind:this`)
 * isn't taken for a module export. But the compiler drops type-only imports,
 * so a type or a file used only by components would read as unused; those are
 * added back from the parsed scripts. (knip's own Svelte reader keeps them, but
 * finds imports with a regex that reads a string like "to import files", as an
 * import of `, `.)
 */
function svelteForKnip(source: string): string {
  const ast = parse(source, { modern: true });
  const typeImports: string[] = [];
  for (const script of [ast.module, ast.instance]) {
    for (const statement of script?.content.body ?? []) {
      if (!isImport(statement)) continue;
      // Svelte's TypeScript parser adds `importKind` and the offsets, which
      // the ESTree types it declares leave out.
      const node: ImportNode = statement;
      if (node.importKind === 'type') {
        typeImports.push(source.slice(node.start, node.end));
        continue;
      }
      const names = node.specifiers
        .filter((specifier) => specifier.importKind === 'type')
        .map((specifier) => source.slice(specifier.start, specifier.end).replace(/^type\s+/, ''));
      if (names.length > 0) {
        typeImports.push(`import type { ${names.join(', ')} } from ${JSON.stringify(node.source.value)};`);
      }
    }
  }
  return [compile(source, {}).js.code, ...typeImports].join('\n');
}

// The electron-vite plug-in finds main, preload and the renderer from
// electron.vite.config.mts, and the Vitest plug-in reads every config an npm
// script names (`--config`), so those entries aren't listed. The scripts run
// by hand (perf/) aren't in any npm script.
export default {
  entry: ['scripts/**/*.mjs', 'src/tests/**/*.{test,e2e}.ts'],
  project: ['src/**/*.{ts,svelte}', 'scripts/**/*.mjs'],
  // An export also used in its own file is not dead code, only a wider
  // surface; knip reports exports nothing uses at all.
  ignoreExportsUsedInFile: true,
  compilers: {
    svelte: svelteForKnip,
  },
} satisfies KnipConfig;
