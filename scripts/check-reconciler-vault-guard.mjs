/**
 * Vault-identity guard gate (Audit-6 Phase 5.3 root-cause B; widened Audit-8
 * Phase 5; extended Audit-9 A9-G1 to the FM-seed primitive + field-edit commands).
 *
 * The external-edit handlers capture the active vault path, `await` a disk read
 * or a build/drain, then mutate a store. A vault swap interleaving on that await
 * applies the OUTGOING vault's data to the NEW vault (H3 tags → persisted
 * cross-vault on disk; H4 board → injected into the cache; L27 theme → outgoing
 * theme re-applied; A8-H2(a) → an external-edit classification applied to the
 * new vault's same-named file). The same shape recurs OUTSIDE the reconcilers:
 * `seedDocumentFrontmatterFromDisk` and the Kanban/Task field-edit commands read
 * the live vault path (or a captured `vaultRoot`), await a disk read, then seed
 * the FM cache / write a `.md` — a swap on that await injects the outgoing
 * vault's frontmatter into the new vault's store (A9-M1) and writes it onto the
 * new vault's same-named file (A9-H1). The discipline that closes the class:
 * `captureVaultIdentity()` before the await, `isStillSameVault(...)` after it,
 * bail before mutating — the G1 guard the rename/cascade paths already use.
 *
 * Audit-11 widens the scan again: Part 1 now also covers `fileTags.svelte.ts`
 * (VS-2 — the single-tag `.md` writers stamp the drift baseline / re-index keyed
 * by relPath alone) and `propertiesCommands.ts` (FILO-UR-2 — `applySnapshot`
 * writes + seeds the FM cache after a drain), and Part 3 adds the rename-cascade
 * RECOVERY repair `repairRenameCascade` (VS-1 — in-memory board/doc/tag mutations
 * driven from a parked recovery modal).
 *
 * Audit-12 H3 widens Part 1 once more to the vault-wide tag rewrite sweep
 * (`fileTagsCascade.svelte.ts`) and adds an `allMetadata` live-read trigger: the
 * sweep read the live `vaultStore.path` + `vaultIndexStore.allMetadata()` and its
 * survive-a-swap retry toast applied the OUTGOING vault's tag op to the swapped-in
 * vault. The fix threads a captured root + `isStillSameVault` guards.
 *
 * Audit-12 M6 widens it to the on-open FM→cache reconcile batch
 * (`boardCacheFrontmatter.ts` `applyFrontmatterToBackedTilesBatch`) via a
 * `getCache` trigger: the batch captures `ctx.getCache()`, yields across
 * microtasks, then does a terminal `ctx.setCache({ ...cache })` — a swap mid-yield
 * would flip the outgoing vault's cache onto the new one. The fix threads the
 * caller's captured identity and bails after each yield + before the setCache.
 *
 * Audit-13 L17 adds an `applyChanges` trigger on `vaultExternalChanges.ts`: the
 * async "Reload" / "Reload all" toast action handlers `await
 * vaultIndexStore.applyChanges([rel])` then synchronously mutate stores (board
 * cache, tags, editor body) keyed by relPath — a swap during that re-read applies
 * the OUTGOING vault's disk content to the NEW vault's same-named file. The
 * handlers are anonymous arrows the unit scan doesn't see, but they live inside
 * the named `prompt*` functions it DOES discover, so the trigger on the containing
 * function's body enforces the guard (it caught two siblings the plan never named:
 * `promptPartialReadExhausted` + `promptExternalEditOnSync`). Audit-13 L16 also
 * converts `handleExternalAttachmentChanges` from a GUARD_EXEMPT path-string
 * compare to a real `isStillSameVault` guard, so its exemption is removed.
 *
 * Prior audits fixed instances of this class per-site; it kept recurring because
 * nothing ENFORCED the re-check. This gate makes the discipline an invariant.
 *
 * ── Part 1: function/method guard scan ───────────────────────────────────────
 * Across the two external-change owners (`vaultExternalReconcilers.ts` and, since
 * Audit-8, `vaultExternalChanges.ts`), any function OR object-literal method that
 * is "vault-scoped" AND contains an `await` MUST reference `isStillSameVault`
 * (or be a documented exemption). "Vault-scoped" triggers are per-file:
 *   - vaultStorePath — reads `vaultStore.path`
 *   - vaultRootParam — takes a `vaultRoot` PARAMETER (a captured root used after
 *     a suspend — the H4 shape). NOT a trigger in `vaultExternalChanges.ts`: the
 *     prompt builders there RECEIVE an already-captured root and use it in a
 *     user-click callback, not after a live-path read, so a vaultRoot param is
 *     not the H2(a) shape there.
 *   - getVaultPath   — reads the live active path via the slice context
 *     `ctx.getVaultPath()` (the accessor the `vaultExternalChanges.ts` slice
 *     uses instead of touching `vaultStore.path` directly).
 *   - allMetadata    — reads the live `vaultIndexStore.allMetadata()` index
 *     (Audit-12 H3). For the vault-wide tag-rewrite sweep this is the same swap
 *     hazard as a live path read: the writes it drives must be anchored to a
 *     CAPTURED root, never the post-swap active vault.
 *
 * A8-H2(a) is `handleExternalMarkdownChanges` — an OBJECT METHOD, so the original
 * function-only discovery never saw it. Discovery now also finds indented
 * object-literal methods. A function whose only `await`s delegate to an
 * already-guarded peer (e.g. `handleExternalRename` threads its captured identity
 * into `runExternalRenameCascade`) never reads the live path itself, so it isn't
 * vault-scoped and naturally passes.
 *
 * GUARD_EXEMPT names the two `vaultExternalChanges.ts` live-path readers that A8
 * left main-side-mitigated rather than converting (each documents why). Crucially
 * the TRIGGER is the intrinsic live-path read, not the guard itself — so REMOVING
 * a guard from `handleExternalMarkdownChanges` cannot evade the gate (the
 * getVaultPath read remains and re-flags it).
 *
 * ── Part 2: path-string swap-guard ratchet (A8-H2(b)) ─────────────────────────
 * H2(b) was `if (vaultPath !== newVaultPath) return;` in `vault.svelte.ts`
 * `runPostCommitTasks` — a path-STRING compare that a close→reopen of the same
 * path (new generation, same string) silently passes, applying the outgoing
 * vault's frontmatter batch to the reopened one. The fix is `isStillSameVault`.
 * This ratchet forbids resurrecting any `=== newVaultPath` / `!== newVaultPath`
 * comparison in that file: a vault-identity check must use the generation-aware
 * guard, never a bare path-string compare.
 *
 * ── Part 3: in-app rename/delete cascade guard (Phase 3 / 3.2) ────────────────
 * The same await-then-mutate shape recurs in the IN-APP disk-shape cascade,
 * `vaultFolderOps.ts`: `runRename` snapshots the board cache, awaits the drained
 * IPC rename, and on failure re-applies the snapshot (`replaceCache`);
 * `performDelete` awaits the IPC delete + a hydrate, then runs the in-memory
 * delete cascade. A vault swap on one of those awaits would apply the OUTGOING
 * vault's snapshot to the NEW vault. The disk IPC is main-side gated by
 * `assertActiveVault`, but the in-memory mutations are not, so both must carry
 * an `isStillSameVault` bail. Part 1's generic scan can't see them (runRename
 * takes a `vaultPath` PARAM, not a live-path read; the `rename` wrapper only
 * delegates), so Part 3 pins the two cascade functions by name.
 *
 * Token checks run against a string/comment-blanked copy of the source, so a
 * comment that merely MENTIONS a forbidden token (the docstrings in
 * `vault.svelte.ts` describe the old shape) or `isStillSameVault` can't
 * satisfy/trip the gate — only real code does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Per-file guard-scan config (see Part 1 above). */
const GUARD_TARGETS = [
  {
    file: 'src/renderer/stores/vaultExternalReconcilers.ts',
    triggers: { vaultStorePath: true, vaultRootParam: true, getVaultPath: false },
    exempt: new Map(),
  },
  {
    file: 'src/renderer/stores/vaultExternalChanges.ts',
    // Audit-13 L17 — `applyChanges` is a fourth trigger here: an async toast
    // action handler that re-reads disk via `vaultIndexStore.applyChanges()` then
    // mutates stores keyed by relPath is the same swap hazard as a live-path read
    // (a vault swap during the re-read applies the OUTGOING vault's disk content
    // to the NEW vault's same-named file). The handlers are anonymous arrows that
    // `findUnits` doesn't see as units, but they live inside the named `prompt*`
    // functions Pass 1 discovers, so the trigger on the CONTAINING function's body
    // catches them (and the already-guarded `handleExternalMarkdownChanges`).
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: true, applyChanges: true },
    exempt: new Map([
      // `handleExternalAttachmentChanges` was here (A8 main-side-mitigated); Audit-13
      // L16 converted it to a real `isStillSameVault` guard, so the exemption is gone
      // and reverting that guard now re-flags it (the bite test relies on this).
      [
        'recreateDeletedFile',
        'user-initiated Keep-local recreate; the write uses the captured vaultRoot ' +
          'which main-side assertActiveVault rejects after a swap (a throw surfaces ' +
          'as a write error, not silent loss). Renderer-side generation guard deferred.',
      ],
    ]),
  },
  // A9-G1 (Audit-9) — the seed primitive + the field-edit command paths. Same
  // class as the reconcilers: read the live vault path (or take a captured
  // vaultRoot), await a disk read, then mutate the FM cache / write a `.md`. A
  // vault swap on that await would inject the OUTGOING vault's frontmatter into
  // the new vault's freshly-cleared store (A9-M1) and, via the command write
  // path, write it onto the NEW vault's same-named file (A9-H1, cross-vault
  // corruption). This gate never scanned these files, so the missing guard
  // passed CI. No exemptions — every flagged site carries an isStillSameVault
  // bail.
  {
    file: 'src/renderer/lib/boards/seedFrontmatterFromDisk.ts',
    // The primitive takes a captured `vaultRoot` PARAMETER and awaits a read on
    // it; it never reads `vaultStore.path` directly.
    triggers: { vaultStorePath: false, vaultRootParam: true, getVaultPath: false },
    exempt: new Map(),
  },
  {
    file: 'src/renderer/commands/kanbanCommands.ts',
    // UpdateCardFieldCommand.execute / UpdateOrphanFrontmatterCommand.execute /
    // applyOrphanPatchRebased each read the live vaultStore.path then await. The
    // command files take captured snapshots (this.vaultRoot, DeleteTaskFile-
    // Options.vaultRoot) as PARAMS for delete paths that are main-side-mitigated,
    // so the vaultRootParam trigger would over-flag — vaultStorePath is the
    // precise A9-H1 shape here.
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: false },
    exempt: new Map(),
  },
  {
    file: 'src/renderer/commands/taskCommands.ts',
    // UpdateTaskFieldCommand.execute reads the live vaultStore.path then awaits.
    // (DeleteTaskCommand.deleteBackingFile takes a captured vaultRoot param but
    // is main-side-mitigated; vaultRootParam stays false to avoid over-flagging.)
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: false },
    exempt: new Map(),
  },
  // Audit-11 VS-2 — the single-tag markdown writers (`writeTagChangeToTileMarkdown`
  // / `writeTagChangeToMarkdownPath`) read the live vaultStore.path, await a read +
  // serialized write, then stamp the drift baseline / re-index keyed by relPath
  // ALONE — so a swap mid-write would poison the NEW vault's same-named file. The
  // cross-vault DISK write is main-side gated by assertActiveVault, but the
  // renderer-side bookkeeping (markPathFailed / refreshBaselineAfterWrite /
  // applyChanges) is not. The file's one other vaultStore.path reader
  // (`resolveTextTileFilePath`) is SYNC, so it never opens a swap window.
  {
    file: 'src/renderer/stores/fileTags.svelte.ts',
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: false },
    exempt: new Map(),
  },
  // Audit-11 FILO-UR-2 — `UpdatePropertiesCommand`'s `applySnapshot` reads the
  // live vaultStore.path after a drain, then writes + seeds the FM cache /
  // baseline. The different-path swap is main-side blocked; the guard closes the
  // close→reopen-same-path window (new generation, same path string) + the stale
  // post-write renderer bookkeeping. `applySnapshot` is the only vaultStore.path
  // reader in the file (`execute` / `undo` just delegate to it).
  {
    file: 'src/renderer/commands/propertiesCommands.ts',
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: false },
    exempt: new Map(),
  },
  // Audit-12 H3 — the vault-wide tag rewrite sweep. `runTagRewriteSweep` used to
  // read the LIVE `vaultStore.path` + `vaultIndexStore.allMetadata()`, and the
  // long-running sweep (plus its survive-a-swap retry toast, whose closure re-read
  // the live path at click time) then applied the OUTGOING vault's tag op to the
  // swapped-in vault — main-side `assertActiveVault` ACCEPTS it because it targets
  // the active vault. The fix threads a captured root into the sweep (writes
  // anchored to the outgoing root → main-side rejected) and `isStillSameVault`-
  // guards every in-memory commit + the retry entry. The TRIGGER is the intrinsic
  // live path/metadata read, so re-introducing that shape + an `await` without the
  // guard re-flags it regardless of the guard's presence. No exemptions.
  {
    file: 'src/renderer/stores/fileTagsCascade.svelte.ts',
    triggers: { vaultStorePath: true, vaultRootParam: false, getVaultPath: false, allMetadata: true },
    exempt: new Map(),
  },
  // Audit-12 M6 — the on-open FM→cache reconcile batch
  // (`applyFrontmatterToBackedTilesBatch`) captures the cache reference
  // (`ctx.getCache()`) ONCE, yields across microtasks (every N md files), then
  // does a terminal `ctx.setCache({ ...cache })`. A vault swap interleaving on
  // one of those yields would flip the OUTGOING vault's reconciled cache onto
  // the NEW vault. It reads `ctx.getCache()`, not `vaultStore.path`, so a
  // dedicated `getCache` trigger catches it; the `await` filter scopes the scan
  // to this one async method (the file's other cache mutators are synchronous,
  // so they have no swap window and are skipped). No exemptions — the batch
  // carries an `isStillSameVault` bail after every yield + before the setCache.
  {
    file: 'src/renderer/stores/boardCacheFrontmatter.ts',
    triggers: { vaultStorePath: false, vaultRootParam: false, getVaultPath: false, getCache: true },
    exempt: new Map(),
  },
];

/** Part 2 — the path-string swap-guard ratchet target + forbidden shapes. */
const RATCHET_FILE = 'src/renderer/stores/vault.svelte.ts';
const RATCHET_PATTERNS = [
  { re: /[!=]==\s*newVaultPath\b/, label: '`=== newVaultPath` / `!== newVaultPath`' },
  { re: /\bnewVaultPath\s*[!=]==/, label: '`newVaultPath ===` / `newVaultPath !==`' },
];

/** Identifiers that can appear as an indented `WORD(` but are NOT definitions. */
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'throw', 'typeof',
  'void', 'delete', 'await', 'yield', 'new', 'in', 'of', 'instanceof', 'case',
  'do', 'else', 'try', 'finally', 'function', 'const', 'let', 'var', 'export',
  'import', 'default', 'super', 'this',
]);

/**
 * Replaces every comment and string/template-literal body with spaces
 * (preserving newlines so line numbers stay meaningful). Token checks then see
 * only real code — a comment naming a forbidden token no longer counts, and a
 * template literal's `${...}` / literal braces can't corrupt brace-matching.
 */
function blankStringsAndComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i += 1; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += c === '\t' ? '\t' : ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // template literal — blank everything (incl. ${...}) until the closing `
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/**
 * Extracts both top-level `function NAME(...)` declarations AND indented
 * object-literal methods (`NAME(...) {` / `async NAME(...) {`) from blanked code.
 * A candidate is a real definition only if the char after its balanced params is
 * `{` (body) or `:` (return type → then a `{`); a call (`foo(x);`) is rejected.
 */
function findUnits(code) {
  const units = [];
  const seen = new Set();

  const addFrom = (headerRe, isMethod) => {
    let m;
    while ((m = headerRe.exec(code))) {
      const name = m[m.length - 1];
      if (isMethod && RESERVED.has(name)) continue;
      // Balance the params from the '(' the header regex just consumed.
      let i = headerRe.lastIndex - 1;
      let depth = 0;
      const paramStart = i + 1;
      let paramEnd = -1;
      for (; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
          depth--;
          if (depth === 0) { paramEnd = i; i++; break; }
        }
      }
      if (paramEnd < 0) continue;
      const params = code.slice(paramStart, paramEnd);
      // After the params, the next non-whitespace must be `{` or `:` — else this
      // is a call / expression, not a definition.
      let k = i;
      while (k < code.length && /\s/.test(code[k])) k++;
      if (code[k] !== '{' && code[k] !== ':') continue;
      // Advance to the body's opening brace (past any return-type annotation).
      let j = k;
      while (j < code.length && code[j] !== '{') j++;
      if (j >= code.length) continue;
      const bodyStart = j;
      let bdepth = 0;
      for (; j < code.length; j++) {
        if (code[j] === '{') bdepth++;
        else if (code[j] === '}') {
          bdepth--;
          if (bdepth === 0) { j++; break; }
        }
      }
      const key = `${name}@${bodyStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      units.push({ name, params, body: code.slice(bodyStart, j) });
    }
  };

  // Pass 1 — `function NAME(` anywhere (top-level / exported).
  addFrom(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, false);
  // Pass 2 — indented object-literal methods (`NAME(` / `async NAME(`).
  addFrom(/(?:^|\n)[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g, true);

  return units;
}

const violations = [];
const ratchetHits = [];

// ── Part 1 — guard scan ──────────────────────────────────────────────────────
for (const target of GUARD_TARGETS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, target.file), 'utf8');
  } catch {
    console.error(`check-reconciler-vault-guard: cannot read ${target.file}`);
    process.exit(1);
  }
  const code = blankStringsAndComments(raw);
  for (const unit of findUnits(code)) {
    const { triggers } = target;
    const triggered =
      (triggers.vaultStorePath && /\bvaultStore\.path\b/.test(unit.body)) ||
      (triggers.vaultRootParam && /\bvaultRoot\b/.test(unit.params)) ||
      (triggers.getVaultPath && /\bgetVaultPath\s*\(/.test(unit.body)) ||
      // Audit-12 H3 — a live read of the metadata index is the same swap hazard as
      // a live vaultStore.path read for the tag-rewrite sweep (the writes it drives
      // must be anchored to a CAPTURED root, not the post-swap active vault).
      (triggers.allMetadata && /\bvaultIndexStore\.allMetadata\s*\(/.test(unit.body)) ||
      // Audit-12 M6 — a captured-cache read (`ctx.getCache()`) that then yields
      // and terminally `setCache`s is the same swap hazard (the captured cache
      // belongs to the outgoing vault). Scoped to the async batch by the await
      // filter below.
      (triggers.getCache && /\bgetCache\s*\(/.test(unit.body)) ||
      // Audit-13 L17 — a function (typically a `prompt*` toast builder) whose body
      // re-reads disk via `vaultIndexStore.applyChanges()` and then mutates stores
      // must re-check vault identity across that await. The TRIGGER is the
      // intrinsic disk re-read, so a new Reload-style handler that forgets the
      // guard is flagged by construction.
      (triggers.applyChanges && /\bvaultIndexStore\.applyChanges\s*\(/.test(unit.body));
    if (!triggered) continue;
    if (!/\bawait\b/.test(unit.body)) continue; // nothing suspends → no swap window
    if (/\bisStillSameVault\b/.test(unit.body)) continue; // guarded — good
    if (target.exempt.has(unit.name)) continue; // documented main-side mitigation
    violations.push({ file: target.file, name: unit.name });
  }
}

// ── Part 2 — path-string swap-guard ratchet ──────────────────────────────────
{
  let raw;
  try {
    raw = readFileSync(join(ROOT, RATCHET_FILE), 'utf8');
  } catch {
    console.error(`check-reconciler-vault-guard: cannot read ${RATCHET_FILE}`);
    process.exit(1);
  }
  const code = blankStringsAndComments(raw);
  for (const { re, label } of RATCHET_PATTERNS) {
    if (re.test(code)) ratchetHits.push(label);
  }
}

// ── Part 3 — in-app rename/delete + recovery cascade guard (Phase 3 / 3.2;
//    Audit-11 VS-1) ─────────────────────────────────────────────────────────
// The in-app rename (`runRename`) and delete (`performDelete`) cascades in
// vaultFolderOps.ts read the active vault path, await the disk-shape IPC + the
// writer drain / hydrate, then mutate the in-memory board cache (the rename
// revert's `replaceCache`, the post-delete cascade). VS-1 adds the rename-
// cascade RECOVERY repair `repairRenameCascade` (renameCascadeRepair.ts): it runs
// in-memory board/doc/tag mutations across awaits, driven from a PARKED recovery
// modal. A vault swap on one of those awaits would apply the OUTGOING vault's
// snapshot/entries to the NEW vault. The disk IPC/writes are main-side gated by
// `assertActiveVault`, but the in-memory mutations are NOT — so each function
// must carry an `isStillSameVault` bail, the same discipline the external-edit
// reconcilers use. The generic findUnits scan in Part 1 can't enforce these:
// `runRename` takes a `vaultPath` PARAM (no live-path read), `repairRenameCascade`
// takes a captured `VaultIdentity` PARAM, and the wrappers only delegate — so pin
// the cascade functions by name here.
const PART3_TARGETS = [
  { file: 'src/renderer/stores/vaultFolderOps.ts', names: ['runRename', 'performDelete'] },
  { file: 'src/renderer/lib/vault/renameCascadeRepair.ts', names: ['repairRenameCascade'] },
];
for (const { file, names } of PART3_TARGETS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    console.error(`check-reconciler-vault-guard: cannot read ${file}`);
    process.exit(1);
  }
  const units = findUnits(blankStringsAndComments(raw));
  for (const name of names) {
    const unit = units.find((u) => u.name === name);
    if (!unit) {
      violations.push({ file, name: `${name} (cascade fn not found — gate target moved?)` });
    } else if (!/\bisStillSameVault\b/.test(unit.body)) {
      violations.push({ file, name });
    }
  }
}

if (violations.length === 0 && ratchetHits.length === 0) {
  console.log('check-reconciler-vault-guard: OK');
  process.exit(0);
}

if (violations.length > 0) {
  console.error('Unguarded vault-scoped function/method(s):');
  for (const v of violations) console.error(`  ${v.file} → ${v.name}`);
  console.error('');
  console.error('Each reads the active vault path (vaultStore.path / ctx.getVaultPath() /');
  console.error('a captured vaultRoot) and then awaits, but never re-checks vault identity.');
  console.error('A vault swap during the await would apply the outgoing vault\'s data to the');
  console.error('new vault. Capture identity before the await and bail after it before mutating:');
  console.error('');
  console.error('  const captured = captureVaultIdentity();');
  console.error('  const data = await <read>;');
  console.error('  if (!isStillSameVault(captured)) return;   // ← swap landed during the read');
  console.error('  <mutate store>');
  console.error('');
  console.error('Both helpers live in src/renderer/lib/vault/vaultIdentity.ts. If a function only');
  console.error('threads a captured identity to an already-guarded peer, read the live path INSIDE');
  console.error('that peer so this function isn\'t itself vault-scoped. If a site is genuinely');
  console.error('mitigated elsewhere (main-side assertActiveVault), add it to GUARD_EXEMPT with a');
  console.error('reason.');
}

if (ratchetHits.length > 0) {
  if (violations.length > 0) console.error('');
  console.error(`Path-string swap guard in ${RATCHET_FILE} (A8-H2(b)):`);
  for (const h of ratchetHits) console.error(`  forbidden: ${h}`);
  console.error('');
  console.error('A vault-identity check must use the generation-aware isStillSameVault(captured),');
  console.error('never a bare path-string compare against newVaultPath: a close→reopen of the same');
  console.error('path is a new vault generation but passes the string compare, applying the');
  console.error('outgoing vault\'s data to the reopened one. Replace the comparison with:');
  console.error('  const identity = captureVaultIdentity();   // before the await');
  console.error('  if (!isStillSameVault(identity)) return;    // after');
}

process.exit(1);
