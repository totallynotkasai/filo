/**
 * Vault-swap reset chain — characterization + lifecycle contract.
 *
 * Phase 0 of the consolidation plan captured the inline reset chain inside
 * `vault.svelte.ts:openVault` as a source-code snapshot. Phase 4
 * replaced that chain with a `vaultLifecycle` subscription registry; this
 * test now asserts the equivalent invariant against the new shape:
 *
 *  1. `openVault` fires `vaultLifecycle.fireVaultSwap({ phase: 'pre-swap', ... })`
 *     before hydrating the new vault, with `saveOutgoing` carrying the
 *     Save / Don't-Save choice.
 *  2. Every store / scheduler / sentinel that previously appeared in the
 *     inline reset chain is now registered as a `pre-swap` (or `post-swap`)
 *     handler via `onVaultSwap(...)`.
 *  3. The Sprint B carry-overs (themeStore, orphansStore, vaultIndexStore
 *     pending retries, saveStateStore failed paths) — previously deferred
 *     skip tests — are subscribed and active.
 *
 * Reading the registered handler names through `__getRegisteredHandlerNames`
 * lets us assert against the subscription side without importing every store
 * module (which would force-instantiate them and pollute the test process).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { __getRegisteredHandlerNames } from '@renderer/core/vaultLifecycle';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VAULT_STORE_PATH = path.join(ROOT, 'src', 'renderer', 'stores', 'vault.svelte.ts');

function extractBodyOf(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`Could not find \`${signature}\` in vault.svelte.ts`);
  // Walk past the parameter list (and any nested `(...)` from defaults
  // or destructuring patterns) so we don't mistake an inline type
  // literal like `{ a: () => void }` for the function body.
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  // Skip the return-type annotation up to the next `{` at column-depth 0.
  const braceStart = text.indexOf('{', i);
  if (braceStart < 0) throw new Error(`No body brace after signature \`${signature}\``);
  depth = 0;
  for (let j = braceStart; j < text.length; j++) {
    const ch = text[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, j + 1);
    }
  }
  throw new Error(`Unbalanced braces extracting body of \`${signature}\``);
}

const VAULT_STORE_TEXT = fs.readFileSync(VAULT_STORE_PATH, 'utf-8');
const OPEN_VAULT_BODY = extractBodyOf(VAULT_STORE_TEXT, 'async openVault(');
// Phase R4 — `openVault` now delegates the hydration sequence to
// `commitVaultCandidate` / `runPostCommitTasks` defined alongside it in
// the same file. The post-swap-hydration assertions below scan the
// union of the three bodies so the contract survives the refactor.
const COMMIT_BODY = extractBodyOf(VAULT_STORE_TEXT, 'function commitVaultCandidate(');
const POST_COMMIT_BODY = extractBodyOf(VAULT_STORE_TEXT, 'function runPostCommitTasks(');
const HYDRATION_REACH = `${OPEN_VAULT_BODY}\n${COMMIT_BODY}\n${POST_COMMIT_BODY}`;

// Pre-swap handlers required by Phase 4 — these names must appear in the
// vaultLifecycle registry once every store module has been loaded.
//
// Phase 3 (IMPL_PLAN 2026-05-25) — three sentinel-mutex chains and the
// dirty-flag mutex now register too, so a straggling sentinel op enqueued
// just before swap can't drag the new vault's first op behind a chain
// targeting the outgoing vault's IPC paths.
const REQUIRED_PRE_SWAP_HANDLERS = [
  'boardCache',
  'boardRefIntegrity',
  'boardWriteScheduler',
  'dirtyFlagRecovery',
  'document',
  'fileTags',
  'history',
  'orphans',
  'pendingSettings',
  'renameCascadeSentinel',
  'saveState',
  'selection',
  'tabs',
  'tagRewriteSentinel',
  'templates',
  'theme',
  'vaultExternalChanges',
  'vaultIndex',
  'workspace',
  'writeStateTracking',
] as const;

beforeAll(async () => {
  // Force every store module to evaluate so its module-init
  // `onVaultSwap(...)` call runs and the registry sees the subscription.
  // Tree-shaking will keep these out of production bundles where they
  // aren't imported anyway, but the test deliberately registers all of
  // them so the coverage assertion is meaningful.
  await Promise.all([
    import('@renderer/stores/boardCache.svelte'),
    import('@renderer/stores/boardRefIntegrity.svelte'),
    import('@renderer/stores/document.svelte'),
    import('@renderer/stores/fileTags.svelte'),
    import('@renderer/stores/history.svelte'),
    import('@renderer/stores/orphans.svelte'),
    import('@renderer/stores/pendingSettings.svelte'),
    import('@renderer/stores/saveState.svelte'),
    import('@renderer/stores/selection.svelte'),
    import('@renderer/stores/tabs.svelte'),
    import('@renderer/stores/templates.svelte'),
    import('@renderer/stores/theme.svelte'),
    import('@renderer/stores/vaultExternalChanges'),
    import('@renderer/stores/vaultIndex.svelte'),
    import('@renderer/stores/workspace.svelte'),
    import('@renderer/lib/boards/boardSaver'),
    // Phase 3 (IMPL_PLAN 2026-05-25) — sentinel mutex modules register
    // their pre-swap handlers at module-init time.
    import('@renderer/lib/vault/dirtyFlagRecovery'),
    import('@renderer/lib/vault/renameCascadeSentinel'),
    import('@renderer/lib/vault/tagRewriteSentinel'),
  ]);
});

describe('Vault-swap reset chain — lifecycle contract', () => {
  describe('openVault fires the pre-swap lifecycle', () => {
    it('calls fireVaultSwap with phase pre-swap', () => {
      expect(OPEN_VAULT_BODY).toMatch(/fireVaultSwap\(/);
      expect(OPEN_VAULT_BODY).toContain("phase: 'pre-swap'");
    });

    it('passes saveOutgoing based on the Save / Don\'t-Save / Cancel choice', () => {
      // The Save branch sets `saveOutgoing: true`; the Don't-Save branch
      // sets `saveOutgoing: false`. The lifecycle handler in
      // writeStateTracking branches on this to clear or preserve the
      // outgoing vault's `.filo/.dirty` sentinel.
      expect(OPEN_VAULT_BODY).toMatch(/saveOutgoing:\s*choice\s*===\s*0/);
    });

    it('reports the outgoing vault path so handlers can flush against it', () => {
      // `previousVault` is null on the very first open and the outgoing
      // vault path on subsequent swaps.
      expect(OPEN_VAULT_BODY).toMatch(/previousVault:\s*vaultPath\s*\|\|\s*null/);
    });
  });

  describe('every required store subscribes a pre-swap handler', () => {
    for (const name of REQUIRED_PRE_SWAP_HANDLERS) {
      it(`vaultLifecycle has a pre-swap handler named "${name}"`, () => {
        const names = __getRegisteredHandlerNames();
        expect(names['pre-swap']).toContain(name);
      });
    }
  });

  describe('renameQueue resets inline after pre-swap (vault.svelte.ts owns the swap)', () => {
    // vault.svelte.ts is exempt from `onVaultSwap` (subscribing would be
    // circular — it owns the dispatcher). Instead the rename queue's chain
    // head must be reset inline immediately after `fireVaultSwap('pre-swap',
    // ...)` returns. Without this, a stale watcher event enqueued just
    // before the swap continues resolving against the now-decommissioned
    // vaultStore state.
    it('renameQueue = Promise.resolve() appears in the openVault body', () => {
      expect(OPEN_VAULT_BODY).toMatch(/renameQueue\s*=\s*Promise\.resolve\(\)/);
    });
  });

  describe('post-swap hydration still happens inside the openVault file', () => {
    // Phase R4 — these steps used to live inline in `openVault`; they
    // now live in `commitVaultCandidate` (synchronous swap) or
    // `runPostCommitTasks` (async best-effort). The test scans the
    // union of the three bodies so the contract — "the hydration
    // sequence still runs as part of the open" — survives the
    // refactor.
    //
    // `themeStore.refreshAvailable` and `themeStore.applyById` no
    // longer appear because the candidate phase loads the cache
    // directly and `themeStore.commitFromCandidate` installs it
    // synchronously. `fileTagsStore.hydrate` is similarly replaced by
    // `fileTagsStore.commitFromCandidate`.
    const hydrationSymbols = [
      'workspaceStore.hydrate(',
      'seedConfigSnapshots(',
      'themeStore.commitFromCandidate(',
      'fileTagsStore.commitFromCandidate(',
      'vaultIndexStore.rebuild(',
      'seedViewportsCache(',
      'tabStore.hydrateFromWorkspace(',
    ] as const;

    for (const needle of hydrationSymbols) {
      it(`openVault + commit + post-commit reaches \`${needle}\``, () => {
        expect(HYDRATION_REACH).toContain(needle);
      });
    }
  });
});
