/**
 * Contract — external-edit reconciliation coverage.
 *
 * Every `FileChangeType` arm has a registered reconciler in
 * `externalChangeRegistry` (once only document + attachment did; board +
 * config-* did NOT), and the renderer's vault listener dispatches through
 * `dispatchExternalChangeBatch` instead of an inline
 * `c.type === 'document' | 'attachment'` filter.
 *
 * The assertions below characterise that contract:
 *
 *   1. `FileChangeType` enumerates `document`, `attachment`, `board`,
 *      `config`, `config-tags`, `config-theme`, `config-template`, `tree`.
 *   2. `externalChangeRegistry.ts` exists and exports the dispatcher.
 *   3. `vaultExternalReconcilers.ts` registers a reconciler for each of the
 *      four new kinds (board, config-tags, config-theme, config-template).
 *   4. `vault.svelte.ts` dispatches through `dispatchExternalChangeBatch`
 *      rather than the inline filter chain.
 *   5. The pre-existing `handleExternalMarkdownChanges` and
 *      `handleExternalAttachmentChanges` are bridged into the registry as
 *      batched reconcilers (registerBatchedReconciler calls).
 *
 * When a future change removes or refactors any of these, this test fails
 * loudly so the author updates the matrix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WATCHER_TYPES_PATH = path.join(
  ROOT,
  'src',
  'main',
  'services',
  'fileWatcherTypes.ts',
);
const VAULT_STORE_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'stores',
  'vault.svelte.ts',
);
const EXTERNAL_CHANGES_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'stores',
  'vaultExternalChanges.ts',
);
const EXTERNAL_RECONCILERS_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'stores',
  'vaultExternalReconcilers.ts',
);
const REGISTRY_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'lib',
  'vault',
  'externalChangeRegistry.ts',
);

const WATCHER_TYPES_TEXT = fs.readFileSync(WATCHER_TYPES_PATH, 'utf-8');
const VAULT_STORE_TEXT = fs.readFileSync(VAULT_STORE_PATH, 'utf-8');
const EXTERNAL_CHANGES_TEXT = fs.readFileSync(EXTERNAL_CHANGES_PATH, 'utf-8');

/**
 * Extract the union arms of `FileChangeType` so we don't drift if the
 * watcher gains or loses a kind. Matches the `| 'kind'` shape used today
 * (see `fileWatcherTypes.ts`).
 */
function extractFileChangeTypeKinds(): Set<string> {
  const start = WATCHER_TYPES_TEXT.indexOf('export type FileChangeType');
  if (start < 0) throw new Error('Could not find FileChangeType declaration');
  const end = WATCHER_TYPES_TEXT.indexOf(';', start);
  if (end < 0) throw new Error('Could not find end of FileChangeType union');
  const decl = WATCHER_TYPES_TEXT.slice(start, end);
  const out = new Set<string>();
  for (const match of decl.matchAll(/'([^']+)'/g)) {
    out.add(match[1]);
  }
  return out;
}

const CURRENT_FILE_CHANGE_KINDS = extractFileChangeTypeKinds();

// ── Tests ──────────────────────────────────────────────────────────────

describe('Contract — external-edit reconciliation coverage', () => {
  describe('FileChangeType union inventory', () => {
    it('enumerates every external-change kind', () => {
      // `config` is split into three granular subtypes
      // (config-tags / config-theme / config-template), with bare
      // `config` kept for un-routed `.filo/` files. The watcher
      // emits eight distinct kinds.
      const actual = [...CURRENT_FILE_CHANGE_KINDS].sort();
      const expected = [
        'attachment',
        'board',
        'config',
        'config-tags',
        'config-template',
        'config-theme',
        'document',
        'tree',
      ];
      expect(actual).toEqual(expected);
    });
  });

  describe('externalChangeRegistry presence', () => {
    it('the registry module exists at src/renderer/lib/vault/externalChangeRegistry.ts', () => {
      expect(fs.existsSync(REGISTRY_PATH)).toBe(true);
    });

    it('the registry module exports dispatchExternalChange + dispatchExternalChangeBatch', () => {
      const text = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      expect(text).toMatch(/export async function dispatchExternalChange\(/);
      expect(text).toMatch(/export async function dispatchExternalChangeBatch\(/);
      expect(text).toMatch(/export function registerReconciler\(/);
      expect(text).toMatch(/export function registerBatchedReconciler\(/);
    });
  });

  describe('vault.svelte.ts uses the dispatcher', () => {
    it('routes vault:files-changed through dispatchExternalChangeBatch', () => {
      expect(VAULT_STORE_TEXT).toMatch(/dispatchExternalChangeBatch\(/);
    });

    it('no longer inline-filters by `c.type === document | attachment`', () => {
      // The old boundary path used these literals; the exhaustive
      // dispatcher replaced them. A future regression that
      // brings the inline filter back is exactly what this test catches.
      // Note: we still expect the comment block to mention the kinds —
      // matching on the array index syntax `c.type === 'document'` would
      // false-positive on prose; restrict to the assignment form.
      expect(VAULT_STORE_TEXT).not.toMatch(/\.filter\(\(c\) => c\.type === ['"]document['"]/);
      expect(VAULT_STORE_TEXT).not.toMatch(/\.filter\(\(c\) => c\.type === ['"]attachment['"]/);
    });

    it('side-effect imports vaultExternalReconcilers so registrations run', () => {
      expect(VAULT_STORE_TEXT).toMatch(/import ['"]\.\/vaultExternalReconcilers['"]/);
    });
  });

  describe('vaultExternalReconcilers.ts registers every new reconciler', () => {
    it('the reconcilers module exists', () => {
      expect(fs.existsSync(EXTERNAL_RECONCILERS_PATH)).toBe(true);
    });

    it('registers single-event reconcilers for board / config-tags / config-theme / config-template', () => {
      const text = fs.readFileSync(EXTERNAL_RECONCILERS_PATH, 'utf-8');
      expect(text).toMatch(/registerReconciler\(\{\s*kind:\s*['"]board['"]/);
      expect(text).toMatch(/registerReconciler\(\{\s*kind:\s*['"]config-tags['"]/);
      expect(text).toMatch(/registerReconciler\(\{\s*kind:\s*['"]config-theme['"]/);
      expect(text).toMatch(/registerReconciler\(\{\s*kind:\s*['"]config-template['"]/);
    });

    it('registers batched reconcilers for document + attachment (legacy bridge)', () => {
      const text = fs.readFileSync(EXTERNAL_RECONCILERS_PATH, 'utf-8');
      expect(text).toMatch(/registerBatchedReconciler\(documentBatchedReconciler\)/);
      expect(text).toMatch(/registerBatchedReconciler\(attachmentBatchedReconciler\)/);
    });
  });

  describe('vaultExternalChanges.ts retains the cross-store coordination', () => {
    // The cross-store coordination logic
    // (`handleExternalMarkdownChanges`, `handleExternalAttachmentChanges`)
    // still lives on the vaultStore mixin because it touches too many
    // peers (vault index, document store, history, popups) to refactor
    // out in one go. The registry's batched reconcilers bridge
    // these methods into the dispatcher rather than re-implementing them.
    it('still exposes handleExternalMarkdownChanges + handleExternalAttachmentChanges', () => {
      expect(EXTERNAL_CHANGES_TEXT).toMatch(/async handleExternalMarkdownChanges\(/);
      expect(EXTERNAL_CHANGES_TEXT).toMatch(/async handleExternalAttachmentChanges\(/);
    });
  });

  describe('watcher supervisor', () => {
    // The supervisor state machine lives in its own
    // module (`watcherSupervisor.ts`) so `fileWatcher.ts` can stay under
    // the file-size ceiling. Each of these assertions targets the
    // dedicated module.
    const supervisorPath = path.join(
      ROOT,
      'src',
      'main',
      'services',
      'watcherSupervisor.ts',
    );

    it('the supervisor module exists at src/main/services/watcherSupervisor.ts', () => {
      expect(fs.existsSync(supervisorPath)).toBe(true);
    });

    it('declares WatcherState union with active / reconnecting / suspended', () => {
      const text = fs.readFileSync(supervisorPath, 'utf-8');
      expect(text).toMatch(/export type WatcherState\s*=/);
      expect(text).toMatch(/['"]active['"]/);
      expect(text).toMatch(/['"]reconnecting['"]/);
      expect(text).toMatch(/['"]suspended['"]/);
    });

    it('uses an exponential reopen backoff schedule', () => {
      const text = fs.readFileSync(supervisorPath, 'utf-8');
      expect(text).toMatch(/WATCHER_REOPEN_BACKOFF_MS\s*=\s*\[/);
    });

    it('broadcasts state changes via vault:watcher-state', () => {
      const text = fs.readFileSync(supervisorPath, 'utf-8');
      expect(text).toMatch(/['"]vault:watcher-state['"]/);
    });
  });
});
