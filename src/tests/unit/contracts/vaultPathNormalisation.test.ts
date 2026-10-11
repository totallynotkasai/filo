/**
 * Contract — `VaultPath` newtype + path-key sweep.
 *
 * Every `Map<string, _>` / `Set<string>` whose name suggests a
 * vault-relative-path key is handled by either:
 *
 *  - re-typing the declaration to `Map<VaultPath, _>` / `Set<VaultPath>`
 *    and routing every callsite through the `vaultPath()` constructor, or
 *  - adding `// allow-string-path-key: <reason>` when the key is
 *    genuinely not a vault-relative path (boardId, tileId, absolute
 *    file-tree path).
 *
 * The CI gate `scripts/gates:vault-path-keys` enforces the contract at
 * error level. These tests assert it from the inside as a regression-
 * resistance net:
 *
 *  1. tagsStorage rename/drop is case-insensitive.
 *  2. `shared/vaultPath` exposes the expected newtype + constructor.
 *  3. No path-keyed `Map<string, _>` / `Set<string>` declarations remain
 *     in src/renderer or src/main — the surface is empty.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  renameFile,
  dropFile,
  emptyTagsFile,
  parseTagsFile,
} from '@renderer/lib/vault/tagsStorage';
import {
  vaultPath,
  isVaultPath,
  normalizeVaultRelative,
  type VaultPath,
} from '@shared/vaultPath';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Behavioural characterisation ────────────────────────────────────────

describe('tagsStorage.renameFile — case-insensitive path keys', () => {
  it('renames a file when old and new keys match in casing (canonical form)', () => {
    const before = {
      ...emptyTagsFile(),
      fileTags: { 'notes/foo.md': ['inbox'] },
    };
    const after = renameFile(before, 'notes/foo.md', 'notes/bar.md');
    expect(after.fileTags).toEqual({ 'notes/bar.md': ['inbox'] });
  });

  it('renames case-insensitively', () => {
    const before = parseTagsFile(
      JSON.stringify({
        version: 1,
        tags: { inbox: { color: '#000' } },
        fileTags: { 'Notes/Foo.md': ['inbox'] },
      }),
    );
    expect(before.fileTags['notes/foo.md']).toEqual(['inbox']);
    expect(before.fileTags['Notes/Foo.md']).toBeUndefined();

    const after = renameFile(before, 'notes/foo.md', 'Notes/Bar.md');
    expect(after.fileTags['notes/bar.md']).toEqual(['inbox']);
    expect(after.fileTags['notes/foo.md']).toBeUndefined();
  });

  it('dropFile matches case-insensitively', () => {
    const before = parseTagsFile(
      JSON.stringify({
        version: 1,
        tags: { inbox: { color: '#000' } },
        fileTags: { 'Notes/Foo.md': ['inbox'] },
      }),
    );
    const after = dropFile(before, 'NoTeS/FOO.md');
    expect(after.fileTags['notes/foo.md']).toBeUndefined();
    expect(Object.keys(after.fileTags)).toEqual([]);
  });
});

// ── `shared/vaultPath` module contract ─────────────────────────────────

describe('shared/vaultPath — exports the newtype + constructor', () => {
  it('exports `vaultPath`, `isVaultPath`, `normalizeVaultRelative`', () => {
    expect(typeof vaultPath).toBe('function');
    expect(typeof isVaultPath).toBe('function');
    expect(typeof normalizeVaultRelative).toBe('function');
  });

  it('`vaultPath()` produces a value usable as a `Map<VaultPath, _>` key', () => {
    const m = new Map<VaultPath, number>();
    m.set(vaultPath('Notes/Foo.md'), 1);
    m.set(vaultPath('notes/foo.md'), 2);
    // Case collision — same key.
    expect(m.size).toBe(1);
    expect(m.get(vaultPath('NOTES/FOO.MD'))).toBe(2);
  });
});

// ── Source-scan contract — the path-key sweep is complete ──────────────

/**
 * Walk `.ts` source files under a root, returning absolute paths. Excludes
 * tests and the `shared/vaultPath.ts` declaration module itself.
 */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface PathKeyedMapDecl {
  file: string;
  line: number;
  text: string;
  identifier: string;
}

/**
 * Same identifier patterns as the CI gate
 * (`scripts/gates:vault-path-keys`). This discovery walk
 * MUST be empty (modulo `// allow-string-path-key:` escape hatches).
 */
const PATH_KEYED_IDENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfileTags\b/,
  /\b\w*ByPath\b/,
  /\bpathTo\w*\b/,
  /\b\w+Paths\b/,
  /\brecentSelfWrites\b/,
  /\blastKnown(Sizes|Hashes)\b/,
  /\bpartialReadRetry(Inflight|Count|Timers)\b/,
];

function discoverPathKeyedMaps(roots: string[]): PathKeyedMapDecl[] {
  const out: PathKeyedMapDecl[] = [];
  for (const root of roots) {
    for (const file of walkSourceFiles(root)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (/(^|\/)src\/shared\/vaultPath\.ts$/.test(rel)) continue;
      if (/(^|\/)src\/renderer\/lib\/utils\/path\.ts$/.test(rel)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const annotationWindow = `${lines[i - 1] ?? ''}\n${line}`;
        if (annotationWindow.includes('allow-string-path-key:')) continue;
        if (/\bVaultPath\b/.test(line)) continue;
        const mapDecl =
          /(new\s+(?:Svelte)?(?:Map|Set)\s*<\s*string\s*(?:,|>)|:\s*(?:Map|Record)\s*<\s*string\s*,)/;
        if (!mapDecl.test(line)) continue;
        const ident =
          /(?:const|let|private|public|protected|readonly)\s+(\w+)/.exec(line)?.[1] ??
          /^\s*(\w+)\s*(?:[:=])/.exec(line)?.[1] ??
          /this\.(\w+)\s*=/.exec(line)?.[1] ??
          null;
        if (!ident) continue;
        if (!PATH_KEYED_IDENT_PATTERNS.some((re) => re.test(ident))) continue;
        out.push({ file: rel, line: i + 1, text: line.trim(), identifier: ident });
      }
    }
  }
  out.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  return out;
}

const PATH_KEYED_MAPS = discoverPathKeyedMaps([
  path.join(ROOT, 'src', 'renderer'),
  path.join(ROOT, 'src', 'main'),
]);

describe('path-key sweep — every path-keyed string map has been migrated', () => {
  it('no `Map<string, _>` / `Set<string>` declarations with path-key identifiers remain', () => {
    // If this fails, a new path-keyed string map slipped through. Either
    // re-type the declaration to `Map<VaultPath, _>` and route callsites
    // through `vaultPath(...)`, or add `// allow-string-path-key: <reason>`
    // if the key is genuinely NOT a vault-relative path. The CI gate
    // `scripts/gates:vault-path-keys` enforces the same contract at error
    // level — the test failure is the friendlier developer signal.
    expect(
      PATH_KEYED_MAPS,
      `The path-key sweep would need to migrate these declarations (see CI gate):\n${PATH_KEYED_MAPS.map(
        (m) => `  ${m.file}:${m.line} ${m.identifier} — ${m.text}`,
      ).join('\n')}`,
    ).toEqual([]);
  });
});
