// Codebase-wide hygiene ratchets.
import { fail } from './lib.mjs';

const SRC_EXT = ['.svelte', '.svelte.ts', '.ts'];
const LOC_LIMIT = 1000;

// Files over LOC_LIMIT, each pinned at its current LOC. They may shrink, not
// grow; the remedy for an over-limit file is to split it, not to raise its row.
const FILE_SIZE_ALLOWLIST = {
  'src/renderer/components/boards/TaskListBoard.svelte': 2209,
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1504,
  'src/renderer/components/boards/TaskItem.svelte': 1545,
  'src/renderer/components/boards/KanbanBoard.svelte': 1471,
  'src/renderer/components/boards/KanbanColumn.svelte': 1198,
  'src/renderer/components/sidebar/VaultFileItem.svelte': 1009,
  'src/renderer/stores/vault.svelte.ts': 1867,
  'src/renderer/stores/vaultFolderOps.ts': 1018,
  'src/renderer/stores/fileTags.svelte.ts': 1236,
  'src/renderer/stores/boardCache.svelte.ts': 1009,
  'src/renderer/lib/vault/markdownFileWriter.ts': 1352,
  'src/renderer/commands/kanbanCommands.ts': 1093,
};

function countLines(text) {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  if (text.charCodeAt(text.length - 1) === 10) count--;
  return count;
}

export const checks = [
  {
    id: 'file-sizes',
    title: 'source files stay under 1000 LOC (allowlisted files may not grow)',
    hint: 'Split the file. Only lower an allowlist ceiling; raising one needs a reviewed reason.',
    run(ctx) {
      const out = [];
      const remaining = new Map(Object.entries(FILE_SIZE_ALLOWLIST));
      for (const rel of ctx.files(['src/main', 'src/renderer'], { ext: SRC_EXT })) {
        const loc = countLines(ctx.read(rel));
        if (remaining.has(rel)) {
          const ceiling = remaining.get(rel);
          if (loc > ceiling) out.push(fail(rel, undefined, `${loc} LOC grew past its allowlist ceiling ${ceiling}`));
          remaining.delete(rel);
        } else if (loc > LOC_LIMIT) {
          out.push(fail(rel, undefined, `${loc} LOC exceeds the ${LOC_LIMIT} LOC limit`));
        }
      }
      for (const rel of remaining.keys()) out.push(fail(rel, undefined, 'allowlist entry no longer exists — remove it'));
      return out;
    },
  },
  {
    id: 'type-casts',
    title: 'no `as any` / `as unknown as` in app source',
    hint: 'Narrow the type properly; if truly unavoidable add `// allow-cast: <reason>` on the line.',
    run(ctx) {
      const out = [];
      const patterns = [
        ['as any', /\bas\s+any\b/],
        ['as unknown as', /\bas\s+unknown\s+as\b/],
      ];
      for (const rel of ctx.files(['src/main', 'src/renderer'], { ext: SRC_EXT })) {
        ctx.read(rel).split('\n').forEach((line, i) => {
          if (line.includes('// allow-cast:')) return;
          for (const [name, re] of patterns) if (re.test(line)) out.push(fail(rel, i + 1, `\`${name}\`: ${line.trim()}`));
        });
      }
      return out;
    },
  },
];
