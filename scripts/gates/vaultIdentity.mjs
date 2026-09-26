// Vault identity, vault-swap reset and vault-path ratchets.
import {
  fail, blank, functionBody, lineAt, stripComments, stripCommentsKeepLines, stripCommentsStateful, tokenChecks,
} from './lib.mjs';

// ── reconciler-vault-guard config ─────────────────────────────────────────
// Per-file triggers that make a function "vault-scoped": it reads the live vault
// (path / index / cache) or takes a captured `vaultRoot`, then awaits.
const GUARD_TARGETS = [
  { file: 'src/renderer/stores/vaultExternalReconcilers.ts', triggers: { vaultStorePath: true, vaultRootParam: true } },
  { file: 'src/renderer/stores/vaultExternalChanges.ts', triggers: { vaultStorePath: true, getVaultPath: true, applyChanges: true } },
  { file: 'src/renderer/stores/vaultExternalPrompts.ts', triggers: { vaultStorePath: true, getVaultPath: true, applyChanges: true } },
  { file: 'src/renderer/stores/vaultExternalDriftPrompts.ts', triggers: { vaultStorePath: true, getVaultPath: true, applyChanges: true } },
  { file: 'src/renderer/stores/notes.svelte.ts', triggers: { activeVaultPath: true } },
  { file: 'src/renderer/stores/notePrompts.ts', triggers: { activeVaultPath: true } },
  { file: 'src/renderer/lib/notes/noteWriter.ts', triggers: { hostVaultRoot: true } },
  { file: 'src/renderer/commands/kanbanCommands.ts', triggers: { vaultStorePath: true } },
  { file: 'src/renderer/commands/taskCommands.ts', triggers: { vaultStorePath: true } },
  { file: 'src/renderer/stores/fileTags.svelte.ts', triggers: { vaultStorePath: true } },
  { file: 'src/renderer/commands/propertiesCommands.ts', triggers: { vaultStorePath: true } },
  { file: 'src/renderer/stores/fileTagsCascade.svelte.ts', triggers: { vaultStorePath: true, allMetadata: true } },
  { file: 'src/renderer/stores/boardCacheFrontmatter.ts', triggers: { getCache: true } },
];
const TRIGGER_RES = {
  vaultStorePath: (u) => /\bvaultStore\.path\b/.test(u.body),
  vaultRootParam: (u) => /\bvaultRoot\b/.test(u.params),
  getVaultPath: (u) => /\bgetVaultPath\s*\(/.test(u.body),
  allMetadata: (u) => /\bvaultIndexStore\.allMetadata\s*\(/.test(u.body),
  getCache: (u) => /\bgetCache\s*\(/.test(u.body),
  applyChanges: (u) => /\bvaultIndexStore\.applyChanges\s*\(/.test(u.body),
  activeVaultPath: (u) => /\bgetActiveVaultPath\s*\(/.test(u.body),
  hostVaultRoot: (u) => /\bhost\.vaultRoot\s*\(/.test(u.body),
};
// Functions that take a captured identity/root param or live where the sweep
// can't reach (anonymous handlers inside), pinned by name.
const GUARD_PINNED = [
  { file: 'src/renderer/stores/vaultFolderOps.ts', names: ['runRename'] },
  { file: 'src/renderer/stores/vaultDeleteOps.ts', names: ['performDelete'] },
  { file: 'src/renderer/stores/trash.svelte.ts', names: ['syncAfterRestore', 'handlePurge', 'offerPermanentDelete'] },
  { file: 'src/renderer/commands/trashedFiles.ts', names: ['trashFiles', 'restoreFiles'] },
  { file: 'src/renderer/lib/vault/renameCascadeRepair.ts', names: ['repairRenameCascade'] },
  { file: 'src/renderer/stores/vault.svelte.ts', names: ['runRecoverySequencer'] },
  { file: 'src/renderer/commands/frontmatterInverse.ts', names: ['applyDeltaChecked'] },
  { file: 'src/renderer/stores/boardDiscovery.ts', names: ['adoptOnce', 'adoptAndFindBoard'] },
  { file: 'src/renderer/stores/boardProvisionalMissing.ts', names: ['recheckProvisionalBoard'] },
  { file: 'src/renderer/stores/fileTags.svelte.ts', names: ['scheduleSave'] },
  { file: 'src/renderer/stores/tagUndo.svelte.ts', names: ['removeTagWithUndo', 'undoRemoval', 'renameTagWithUndo', 'undoRename'] },
];
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'throw', 'typeof', 'void', 'delete', 'await', 'yield',
  'new', 'in', 'of', 'instanceof', 'case', 'do', 'else', 'try', 'finally', 'function', 'const', 'let', 'var',
  'export', 'import', 'default', 'super', 'this',
]);

/** Top-level `function NAME(` declarations and indented object/class methods, from blanked code. */
function findUnits(code) {
  const units = [];
  const seen = new Set();
  const scan = (re, isMethod) => {
    for (const m of code.matchAll(re)) {
      const name = m[m.length - 1];
      if (isMethod && RESERVED.has(name)) continue;
      let i = m.index + m[0].length - 1;
      const paramStart = i + 1;
      let paramEnd = -1;
      for (let depth = 0; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) { paramEnd = i; i++; break; }
      }
      if (paramEnd < 0) continue;
      let k = i;
      while (k < code.length && /\s/.test(code[k])) k++;
      if (code[k] !== '{' && code[k] !== ':') continue;
      let j = code.indexOf('{', k);
      if (j < 0) continue;
      const bodyStart = j;
      for (let depth = 0; j < code.length; j++) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}' && --depth === 0) { j++; break; }
      }
      const key = `${name}@${bodyStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      units.push({ name, params: code.slice(paramStart, paramEnd), body: code.slice(bodyStart, j) });
    }
  };
  scan(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, false);
  scan(/(?:^|\n)[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g, true);
  return units;
}

// ── vault-lifecycle-coverage config ───────────────────────────────────────
const LIFECYCLE_EXEMPT = new Map([
  ['src/renderer/stores/board.svelte.ts', 'per-BoardScope factory'],
  ['src/renderer/stores/canvas.svelte.ts', 'per-BoardScope factory'],
  ['src/renderer/stores/spatial.svelte.ts', 'per-BoardScope factory'],
  ['src/renderer/stores/toolbar.svelte.ts', 'TipTap toolbar mirror; resets per editor focus'],
  ['src/renderer/lib/boards/boardScope.svelte.ts', 'per-pane scope factory'],
  ['src/renderer/lib/kanban/kanbanDragController.svelte.ts', 'per-board controller'],
  ['src/renderer/lib/kanban/kanbanFiltersAndSort.svelte.ts', 'per-board state'],
  ['src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts', 'per-board state'],
  ['src/renderer/lib/mindmap/marqueeSelectionController.svelte.ts', 'per-board controller'],
  ['src/renderer/lib/tasklist/filtersAndViews.svelte.ts', 'per-board state'],
  ['src/renderer/lib/tasklist/multiSelectController.svelte.ts', 'per-board state'],
  ['src/renderer/lib/tasklist/taskDragController.svelte.ts', 'per-board controller'],
  ['src/renderer/lib/tasklist/datePickerViewState.svelte.ts', 'per-popover state'],
  ['src/renderer/lib/tasklist/notesBox.svelte.ts', 'per-row notes box, dies with the row'],
  ['src/renderer/lib/utils/ariaAnnouncer.svelte.ts', 'per-instance announcer, disposed on unmount'],
]);
// Subscribing proves a reset is wired, not that it resets: pin the behavioural reset tests.
const RESET_COVERAGE = [
  { module: 'src/renderer/stores/vaultRecovery.ts', test: 'src/tests/unit/vaultRecovery.test.ts', token: /acknowledgeRecovery/ },
  { module: 'src/renderer/lib/vault/dirtyFlagRecovery.ts', test: 'src/tests/unit/dirtyFlagRecovery.test.ts', token: /checkRecovery/ },
  { module: 'src/renderer/lib/boards/writeStateTracking.ts', test: 'src/tests/unit/writeFlushParkedAndGenerations.test.ts', token: /__resetDirtyTrackingForTests/ },
  { module: 'src/renderer/stores/notes.svelte.ts', test: 'src/tests/unit/noteStore.test.ts', token: /a vault swap drops every model/ },
  { module: 'src/renderer/stores/fileTags.svelte.ts', test: 'src/tests/unit/fileTagsCascade.test.ts', token: /fileTagsStore\.reset\s*\(/ },
];

// ── relpath-rename-transfer config ────────────────────────────────────────
const RENAME_SCAN = ['src/renderer/stores', 'src/renderer/lib/vault', 'src/renderer/lib/boards', 'src/renderer/lib/notes'];
const RENAME_EXEMPT_OWNERS = new Map([
  ['src/renderer/stores/vaultIndex.svelte.ts', 'vaultIndexStore.renameKey'],
  ['src/renderer/stores/boardCache.svelte.ts', 'boardCacheStore.renameBoardPath'],
  ['src/renderer/stores/fileTags.svelte.ts', 'fileTagsStore.renameFile / renameFolder'],
  ['src/renderer/lib/boards/writeStateTracking.ts', 'TTL-expiring entries; a rename mid-window is harmless'],
  ['src/renderer/lib/boards/configWriteScheduler.ts', 'keyed by ConfigTarget literal, not path'],
  ['src/renderer/lib/boards/viewportCache.ts', 'keyed by boardId, not path'],
  ['src/renderer/lib/vault/externalChangeWindows.ts', 'short windows; entries expire harmlessly'],
  ['src/renderer/lib/boards/boardLoader.ts', 'immutable lookup table'],
  ['src/renderer/lib/boards/tileDefBuilder.ts', 'immutable lookup table'],
]);
const PATH_IDENTS = [/^fileState$/, /^baselines$/, /^inFlight\w*$/i, /Path(?:s|Map)?$/, /ByPath$/];

// ── vault-path-keys config ────────────────────────────────────────────────
const PATH_KEY_IDENTS = [
  /\bfileTags\b/, /\b\w*ByPath\b/, /\bpathTo\w*\b/, /\b\w+Paths\b/, /\brecentSelfWrites\b/,
  /\blastKnown(Sizes|Hashes)\b/, /\bpartialReadRetry(Inflight|Count|Timers)\b/,
];

// ── no-raw-disk-shape-ipc config ──────────────────────────────────────────
const DISK_SHAPE_ALLOWLIST = new Set([
  'src/renderer/lib/vault/vaultOperations.ts',
  'src/renderer/lib/vault/tagRewriteSentinel.ts',
  'src/renderer/lib/vault/renameCascadeSentinel.ts',
  'src/renderer/lib/vault/dirtyFlagRecovery.ts',
  'src/renderer/lib/vault/quitFailureRecovery.ts',
  'src/renderer/lib/vault/machineSentinels.ts',
]);
const DISK_SHAPE_CHANNELS = [
  'vault:rename', 'vault:delete', 'vault:create-folder', 'vault:copy-file',
  'vault:trash-move', 'vault:trash-restore', 'vault:trash-purge', 'vault:trash-delete-permanently',
];

// ── board-path-casefold helpers ───────────────────────────────────────────
function firstForLoopBody(code) {
  const m = /\bfor\b/.exec(code);
  if (!m) return null;
  let i = code.indexOf('(', m.index);
  for (let depth = 0; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) { i++; break; }
  }
  while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
  if (code[i] !== '{') return null;
  const start = i;
  for (let depth = 0; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

export const checks = [
  {
    id: 'reconciler-vault-guard',
    title: 'code that reads the live vault and then awaits re-checks isStillSameVault',
    hint:
      'A vault swap during the await applies the outgoing vault’s data to the new one. Capture identity before ' +
      'the await and bail with `if (!isStillSameVault(captured)) return;` after it (lib/vault/vaultIdentity.ts).',
    run(ctx) {
      const out = [];
      for (const t of GUARD_TARGETS) {
        const raw = ctx.read(t.file);
        if (raw === null) { out.push(fail(t.file, undefined, 'target file missing')); continue; }
        for (const u of findUnits(blank(raw))) {
          const triggered = Object.keys(t.triggers).some((k) => t.triggers[k] && TRIGGER_RES[k](u));
          if (!triggered || !/\bawait\b/.test(u.body) || /\bisStillSameVault\b/.test(u.body)) continue;
          if (t.exempt?.has(u.name)) continue;
          out.push(fail(t.file, undefined, `${u.name}() reads the live vault and awaits without isStillSameVault`));
        }
      }
      // A path-STRING swap compare passes a close→reopen of the same path (new generation).
      const VAULT = 'src/renderer/stores/vault.svelte.ts';
      const vaultRaw = ctx.read(VAULT);
      if (vaultRaw === null) out.push(fail(VAULT, undefined, 'target file missing'));
      const vault = blank(vaultRaw ?? '');
      if (/[!=]==\s*newVaultPath\b/.test(vault) || /\bnewVaultPath\s*[!=]==/.test(vault)) {
        out.push(fail(VAULT, undefined, 'compares against newVaultPath — use isStillSameVault(captured)'));
      }
      for (const { file, names } of GUARD_PINNED) {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'target file missing')); continue; }
        const units = findUnits(blank(raw));
        for (const name of names) {
          const u = units.find((x) => x.name === name);
          if (!u) out.push(fail(file, undefined, `${name}() not found — re-point the check`));
          else if (!/\bisStillSameVault\b/.test(u.body)) out.push(fail(file, undefined, `${name}() mutates after awaits without isStillSameVault`));
        }
      }
      return out;
    },
  },
  {
    id: 'vault-lifecycle-coverage',
    title: 'modules with module-level reactive state subscribe to onVaultSwap',
    hint:
      "Without a reset, the previous vault's state leaks into the next one. Add " +
      "`onVaultSwap('pre-swap', 'name', () => …)` or list a per-pane/transient module in LIFECYCLE_EXEMPT.",
    run(ctx) {
      const out = [];
      const STATE = /\$state\s*[<(]/;
      const MODULE_REACTIVE = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+[^\n=]*=\s*new\s+Svelte(?:Map|Set)\s*\(/m;
      const SUBSCRIBE = /(?<![A-Za-z0-9_$])onVaultSwap\s*\(/;
      for (const rel of ctx.files('src/renderer', { ext: ['.ts'] })) {
        if (rel === 'src/renderer/core/vaultLifecycle.ts') continue;
        const code = stripComments(ctx.read(rel));
        if (!STATE.test(code) && !MODULE_REACTIVE.test(code)) continue;
        const subscribes = SUBSCRIBE.test(code);
        if (LIFECYCLE_EXEMPT.has(rel)) {
          if (subscribes) out.push(fail(rel, undefined, 'exempt module now subscribes — remove it from LIFECYCLE_EXEMPT'));
        } else if (!subscribes) {
          out.push(fail(rel, undefined, 'module-level reactive state but no onVaultSwap subscription'));
        }
      }
      for (const { module, test, token } of RESET_COVERAGE) {
        if (ctx.read(module) === null) { out.push(fail(module, undefined, 'RESET_COVERAGE module missing — update the manifest')); continue; }
        const src = ctx.read(test);
        if (!src) out.push(fail(test, undefined, `reset test for ${module} is missing`));
        else if (!token.test(src)) out.push(fail(test, undefined, `no longer exercises ${module}'s reset (missing /${token.source}/)`));
      }
      return out;
    },
  },
  {
    id: 'vault-scoped-state',
    title: 'module-scope Map/Set/Promise chains in stores + vault/board libs reset on vault swap',
    hint:
      "Subscribe with vaultSwapResettable('name', () => …) or onVaultSwap(...), or mark a genuinely shared " +
      'declaration `// allow-module-state: <reason>` (same or preceding line).',
    run(ctx) {
      const out = [];
      const DECL = /^(?:let|const)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*(?:new\s+(?:(?:Weak|Svelte)?(?:Map|Set))\b|Promise\.resolve\b)/m;
      const SUBSCRIBE = /(?<![A-Za-z0-9_$])(?:onVaultSwap|vaultSwapResettable)\s*\(/;
      for (const rel of ctx.files(RENAME_SCAN, { ext: ['.ts'] })) {
        const raw = ctx.read(rel);
        const code = stripCommentsKeepLines(raw);
        const rawLines = raw.split(/\r?\n/);
        const hasState = code.split(/\r?\n/).some(
          (l, i) => DECL.test(l) && !/\/\/\s*allow-module-state:\s*\S+/.test(`${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`),
        );
        if (hasState && !SUBSCRIBE.test(code)) out.push(fail(rel, undefined, 'module-scoped chained state but no onVaultSwap / vaultSwapResettable'));
      }
      return out;
    },
  },
  {
    id: 'sentinel-machine-scoped',
    title: 'crash-recovery sentinels are only named via the per-machine builder',
    hint:
      '.filo/ syncs between machines; a shared sentinel name lets one machine clear or resume another’s crash state. ' +
      'Use machineSentinelPath / ownSentinelPath (src/shared/sentinelPaths.ts).',
    run(ctx) {
      const out = [];
      const FORBIDDEN = ['.filo/.dirty', '.filo/rename-cascade-pending.json', '.filo/tag-rewrite-pending.json', '.filo/quit-failure.json'];
      const files = ctx.files(['src/main', 'src/renderer'], { ext: ['.ts', '.svelte', '.mjs'] });
      for (const rel of files) {
        stripCommentsStateful(ctx.read(rel)).split('\n').forEach((line, i) => {
          for (const lit of FORBIDDEN) {
            for (const q of ["'", '"']) if (line.includes(`${q}${lit}${q}`)) out.push(fail(rel, i + 1, `shared (not per-machine) sentinel literal ${q}${lit}${q}`));
          }
        });
      }
      if (files.length < 150) out.push(fail('src', undefined, `tripwire: only ${files.length} files scanned (expected >= 150)`));
      return out;
    },
  },
  {
    id: 'relpath-rename-transfer',
    title: 'path-keyed module maps register a rename sweep',
    hint:
      'A path-keyed cache that ignores renames strands its entry at the old path. Call ' +
      "registerPathRenamable('module.field', fn), list the peer that renames it in RENAME_EXEMPT_OWNERS, " +
      'or annotate `// allow-no-rename-transfer: <reason>`.',
    run(ctx) {
      const out = [];
      const VAULTPATH_DECL = /^(?:let|const)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*new\s+(?:Weak|Svelte)?(?:Map|Set)\s*<\s*VaultPath\b/;
      const STRING_DECL = /^(?:let|const)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*new\s+(?:Weak|Svelte)?(?:Map)\s*<\s*string\s*,/;
      for (const rel of ctx.files(RENAME_SCAN, { ext: ['.ts'] })) {
        const raw = ctx.read(rel);
        const code = stripCommentsKeepLines(raw);
        const rawLines = raw.split(/\r?\n/);
        const hits = [];
        code.split(/\r?\n/).forEach((line, i) => {
          const s = STRING_DECL.exec(line);
          if (!VAULTPATH_DECL.test(line) && !(s && PATH_IDENTS.some((re) => re.test(s[1])))) return;
          if (/\/\/\s*allow-no-rename-transfer:\s*\S+/.test(`${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`)) return;
          hits.push(i + 1);
        });
        if (!hits.length || RENAME_EXEMPT_OWNERS.has(rel) || /\bregisterPathRenamable\s*\(/.test(code)) continue;
        for (const line of hits) out.push(fail(rel, line, `path-keyed map without a rename sweep: ${(rawLines[line - 1] ?? '').trim()}`));
      }
      return out;
    },
  },
  {
    id: 'vault-path-keys',
    title: 'path-keyed maps use the case-folding VaultPath key',
    hint:
      'A raw-string path key strands entries on a case-only rename (Windows/macOS). Type it Map<VaultPath, …> and ' +
      'key via vaultPath(); if the key is not a vault path, rename it and add `// allow-string-path-key: <reason>`.',
    run(ctx) {
      const out = [];
      const MAP_DECL = /(new\s+(?:Svelte)?(?:Map|Set)\s*<\s*string\s*(?:,|>)|:\s*(?:Map|Record)\s*<\s*string\s*,)/;
      for (const rel of ctx.files(['src/renderer', 'src/main'], { ext: ['.ts'] })) {
        if (rel === 'src/renderer/lib/utils/path.ts') continue;
        const lines = ctx.read(rel).split('\n');
        lines.forEach((line, i) => {
          if (`${lines[i - 1] ?? ''}\n${line}`.includes('allow-string-path-key:')) return;
          if (/\bVaultPath\b/.test(line) || !MAP_DECL.test(line)) return;
          const ident =
            /(?:const|let|private|public|protected|readonly)\s+(\w+)/.exec(line)?.[1] ??
            /^\s*(\w+)\s*(?:[:=])/.exec(line)?.[1] ??
            /this\.(\w+)\s*=/.exec(line)?.[1];
          if (ident && PATH_KEY_IDENTS.some((re) => re.test(ident))) out.push(fail(rel, i + 1, `\`${ident}\` is keyed by a raw string path`));
        });
      }
      // VaultIndex's `metadata` map is not caught by the name heuristic; pin its fold explicitly.
      const INDEX = 'src/renderer/lib/vault/vaultIndex.ts';
      const raw = ctx.read(INDEX);
      if (raw === null) return [...out, fail(INDEX, undefined, 'file missing — VaultIndex fold check cannot run')];
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (!/\bmetadata\s*=\s*new\s+Map<\s*VaultPath\s*,/.test(code)) out.push(fail(INDEX, undefined, '`metadata` must be typed Map<VaultPath, …>'));
      const keyOf = /\bkeyOf\s*\([^)]*\)\s*:\s*VaultPath\s*\{([\s\S]*?)\}/.exec(code);
      if (!keyOf) out.push(fail(INDEX, undefined, 'missing a `keyOf(path): VaultPath` helper'));
      else if (!/\b(?:vaultPath|normalizeVaultRelative)\s*\(/.test(keyOf[1])) out.push(fail(INDEX, undefined, 'keyOf must fold through vaultPath( / normalizeVaultRelative('));
      let sawId = false;
      for (const m of code.matchAll(/\bconst\s+(id|oldId|newId)\s*=\s*([^;\n]+)/g)) {
        sawId = true;
        if (!/\bthis\.keyOf\s*\(/.test(m[2])) out.push(fail(INDEX, undefined, `\`const ${m[1]} = ${m[2].trim()}\` must derive the key via this.keyOf(`));
      }
      if (!sawId) out.push(fail(INDEX, undefined, 'expected a `const id|oldId|newId = this.keyOf(…)` key derivation'));
      return out;
    },
  },
  {
    // Merged: the renderer and main-process variants were the same scan over two trees.
    id: 'no-inline-path-normalize',
    title: 'separator normalisation goes through the canonical path helpers',
    hint:
      'Use toPosix / normalizePath / toVaultRelative (src/shared/pathUtils.ts, re-exported by renderer ' +
      'lib/utils/path.ts), normalizeVaultRelative (src/shared/vaultPath.ts) or the main utils/pathHelpers.ts ' +
      'relativePosix, or `// allow-inline-normalize: <reason>` on the line.',
    run(ctx) {
      const out = [];
      const PATTERN = /replace\(\/\\\\\/g,\s*['"]\/['"]\)/;
      const files = [
        ...ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts', '.ts'] }),
        ...ctx.files('src/main', { ext: ['.ts'] }),
      ];
      for (const rel of files) {
        if (rel === 'src/renderer/lib/utils/path.ts' || rel === 'src/main/utils/pathHelpers.ts') continue;
        ctx.read(rel).split('\n').forEach((line, i) => {
          if (!line.includes('// allow-inline-normalize:') && PATTERN.test(line)) out.push(fail(rel, i + 1, line.trim()));
        });
      }
      return out;
    },
  },
  {
    id: 'board-path-casefold',
    title: 'board path + extension compares are case-insensitive; duplicate ids rank by name and mtime',
    hint:
      'Windows/macOS are case-insensitive: compare board paths via samePath / normalizeVaultRelative and lower-case ' +
      'before `.endsWith(.board.json)`, or an externally re-cased board is ignored / misrouted.',
    run(ctx) {
      const out = [];
      const body = (file, name) => {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'file missing')); return null; }
        const fn = functionBody(blank(raw), name);
        if (!fn) out.push(fail(file, undefined, `${name}() not found`));
        return fn?.text ?? null;
      };

      const RECON = 'src/renderer/stores/boardDrift.ts';
      const find = body(RECON, 'findBoardIdForPath');
      if (find !== null) {
        out.push(
          ...tokenChecks(RECON, find, {
            required: [{ token: /\bsamePath\s*\(/, why: 'findBoardIdForPath resolves via samePath' }],
            forbidden: [
              { token: /===|!==/, why: 'raw case-sensitive equality in findBoardIdForPath' },
              { token: /\.startsWith\s*\(/, why: 'raw case-sensitive prefix compare in findBoardIdForPath' },
            ],
          }),
        );
      }

      const CACHE = 'src/renderer/stores/boardCache.svelte.ts';
      const rename = body(CACHE, 'renameBoardPath');
      if (rename !== null) {
        if (!/\bnormalizeVaultRelative\s*\(/.test(rename)) out.push(fail(CACHE, undefined, 'renameBoardPath never folds via normalizeVaultRelative'));
        const loop = firstForLoopBody(rename);
        if (loop === null) out.push(fail(CACHE, undefined, 'renameBoardPath rebind loop not found'));
        else {
          if (!/\bnormalizeVaultRelative\s*\(/.test(loop)) out.push(fail(CACHE, undefined, 'renameBoardPath loop never folds an entry'));
          const folded = [...rename.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*normalizeVaultRelative\s*\(/g)].map((m) => m[1]);
          for (const line of loop.split('\n')) {
            if (!/===|!==|\.startsWith\s*\(/.test(line) || /normalizeVaultRelative\s*\(/.test(line)) continue;
            if (!folded.some((n) => new RegExp(`\\b${n}\\b`).test(line))) {
              out.push(fail(CACHE, undefined, `renameBoardPath loop compares an un-folded path: \`${line.trim()}\``));
            }
          }
        }
      }

      const LOADER = 'src/renderer/lib/boards/boardLoader.ts';
      const loadAll = body(LOADER, 'loadAllBoards');
      if (loadAll !== null) {
        out.push(
          ...tokenChecks(LOADER, loadAll, {
            required: [
              { token: /\bdetectConflictCopy\w*\s*\(/, why: 'loadAllBoards ranks sync conflict copies below the canonical file' },
              { token: /\bcompareDuplicateBoards\s*\(/, why: 'duplicate board ids go through the name/mtime ranking' },
            ],
            forbidden: [
              {
                token: /hasOwnProperty\s*\.\s*call\s*\(\s*cache\s*,\s*data\s*\.\s*board\s*\.\s*id\s*\)/,
                why: 'first-file-wins duplicate guard (scan order picks the winner)',
              },
            ],
          }),
        );
      }
      const compare = body(LOADER, 'compareDuplicateBoards');
      if (compare !== null && !/\bmtimeMs\b/.test(compare)) out.push(fail(LOADER, undefined, 'compareDuplicateBoards must prefer the newest file (mtimeMs)'));

      for (const file of ['src/main/vault/boardFileOps.ts', 'src/main/services/fileWatcherClassify.ts']) {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'file missing')); continue; }
        const code = blank(raw, { strings: false });
        const hits = [...code.matchAll(/\.endsWith\s*\(\s*(?:BOARD_EXTENSION|['"]\.board\.json['"])\s*\)/g)];
        if (!hits.length) out.push(fail(file, undefined, 'no `.endsWith(<board-ext>)` compare found — re-point the check'));
        for (const m of hits) {
          if (!/\.toLowerCase\(\)\s*$/.test(code.slice(0, m.index))) {
            out.push(fail(file, lineAt(code, m.index), `\`${m[0].trim()}\` is not on a .toLowerCase() receiver`));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'no-raw-disk-shape-ipc',
    title: 'rename / delete / create-folder / copy-file IPC goes through vaultOperations',
    hint:
      'vaultOperations drains pending writes before the disk shape changes; a raw invoke races a debounced write ' +
      'against a moved path. Escape: `// allow-disk-shape-ipc: <reason>` on the line.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (DISK_SHAPE_ALLOWLIST.has(rel)) continue;
        const src = ctx.read(rel);
        if (!DISK_SHAPE_CHANNELS.some((c) => src.includes(c))) continue;
        const lines = src.split('\n');
        for (const channel of DISK_SHAPE_CHANNELS) {
          const re = new RegExp(String.raw`\b(?:invoke|invokeOk)\s*\(\s*['"\`]` + channel.replace(/[-:./]/g, (x) => `\\${x}`) + String.raw`['"\`]`, 'g');
          for (const m of src.matchAll(re)) {
            const line = lineAt(src, m.index);
            if (/\/\/\s*allow-disk-shape-ipc:/.test(lines[line - 1])) continue;
            out.push(fail(rel, line, `raw ${channel}: ${lines[line - 1].trim()}`));
          }
        }
      }
      return out;
    },
  },
];
