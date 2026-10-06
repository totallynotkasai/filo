import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertNotInFiloDir,
  FiloDirForbiddenError,
} from '../../main/utils/pathSecurity';
import { __setMachineIdentityForTests } from '../../main/services/machineIdentity';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 1 / 1.2 — every generic `vault:*` IPC handler that mutates the
 * filesystem (write-file-text, write-existing-file-text, delete, rename,
 * copy-file, create-folder) now runs the path it was handed through
 * `assertNotInFiloDir` so a buggy renderer cannot end-run the dedicated
 * `config:save` / `tags:save` / `templates:write` / `theme:save` channels
 * and clobber `.filo/` state with arbitrary text.
 *
 * The 8 cases below mirror the 6 IPC handlers (rename + copy-file each
 * check both endpoints, hence 8). This machine's own recovery sentinels stay allowlisted
 * inside the helper because `dirtyFlagRecovery` / `renameCascadeSentinel`
 * / `tagRewriteSentinel` legitimately go through `vault:write-file-text`.
 */
/** A vault root that doesn't exist: the guard's on-disk spelling of a path under it is the path itself. */
const VAULT = join(tmpdir(), 'filo-guard-vault');

describe('vault IPC `.filo/` guard — assertNotInFiloDir', () => {
  it('throws FORBIDDEN for vault:write-file-text → ".filo/app.json"', () => {
    expect(() => assertNotInFiloDir(VAULT, '.filo/app.json')).toThrow(FiloDirForbiddenError);
    expect(() => assertNotInFiloDir(VAULT, '.filo/app.json')).toThrow(/FORBIDDEN/);
  });

  it('throws FORBIDDEN for vault:write-existing-file-text → ".filo/defaults.json"', () => {
    expect(() => assertNotInFiloDir(VAULT, '.filo/defaults.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:delete → ".filo/tags.json"', () => {
    // delete handler computes `relative(vaultRoot, itemPath)` and feeds
    // it to assertNotInFiloDir; the rel path here mimics that result.
    expect(() => assertNotInFiloDir(VAULT, '.filo/tags.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:rename source → ".filo/old.json"', () => {
    expect(() => assertNotInFiloDir(VAULT, '.filo/old.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:rename dest → ".filo/new.json"', () => {
    expect(() => assertNotInFiloDir(VAULT, '.filo/new.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:copy-file source → ".filo/cfg.json"', () => {
    // copy-file's source-inside-vault check feeds `relative(vault, src)`
    // when the source happens to live inside the vault — paths inside
    // `.filo/` are refused.
    expect(() => assertNotInFiloDir(VAULT, '.filo/cfg.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:copy-file dest → ".filo/copy.png"', () => {
    // copy-file's destination check feeds `{subfolder}/{basename(src)}`.
    expect(() => assertNotInFiloDir(VAULT, '.filo/copy.png')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:create-folder → ".filo/subdir"', () => {
    expect(() => assertNotInFiloDir(VAULT, '.filo/subdir')).toThrow(FiloDirForbiddenError);
  });

  // ── Non-`.filo` paths pass through ──────────────────────────────────
  describe('legitimate vault paths are permitted', () => {
    it('permits a plain markdown file at vault root', () => {
      expect(() => assertNotInFiloDir(VAULT, 'Notes.md')).not.toThrow();
    });

    it('permits a nested attachment path', () => {
      expect(() => assertNotInFiloDir(VAULT, 'attachments/2026/photo.png')).not.toThrow();
    });

    it('permits a board file path', () => {
      expect(() => assertNotInFiloDir(VAULT, 'Kanban/MyBoard/foo.board.json')).not.toThrow();
    });

    it('permits a folder name that merely STARTS with .filo (not equal)', () => {
      // First-segment EQUALITY check — a folder called `.filosophy` is
      // not the same as `.filo` and must pass.
      expect(() => assertNotInFiloDir(VAULT, '.filosophy/Notes.md')).not.toThrow();
    });

    it('permits an empty / null input (upstream validators handle those)', () => {
      expect(() => assertNotInFiloDir(VAULT, '')).not.toThrow();
      expect(() => assertNotInFiloDir(VAULT, null as unknown as string)).not.toThrow();
      expect(() => assertNotInFiloDir(VAULT, undefined as unknown as string)).not.toThrow();
    });
  });

  // ── Recovery sentinel allowlist ─────────────────────────────────────
  // Only this machine's own per-machine sentinels pass; a bare shared name
  // names no machine, so it is ordinary `.filo/` state and stays refused.
  describe('recovery sentinels remain permitted (allowlist)', () => {
    const ME = 'aaaaaaaaaaaa';
    beforeEach(() => __setMachineIdentityForTests({ machineId: ME, hostname: 'A' }));
    afterEach(() => __setMachineIdentityForTests(null));

    it('permits .filo/.dirty.<id> (dirty-flag sentinel)', () => {
      expect(() => assertNotInFiloDir(VAULT, `.filo/.dirty.${ME}`)).not.toThrow();
    });

    it('permits .filo/rename-cascade-pending.<id>.json (rename sentinel)', () => {
      expect(() => assertNotInFiloDir(VAULT, `.filo/rename-cascade-pending.${ME}.json`)).not.toThrow();
    });

    it('permits .filo/tag-rewrite-pending.<id>.json (tag-rewrite sentinel)', () => {
      expect(() => assertNotInFiloDir(VAULT, `.filo/tag-rewrite-pending.${ME}.json`)).not.toThrow();
    });

    it('permits .filo/quit-failure.<id>.json (quit-failure breadcrumb)', () => {
      expect(() => assertNotInFiloDir(VAULT, `.filo/quit-failure.${ME}.json`)).not.toThrow();
    });

    it('refuses the bare shared names', () => {
      for (const bare of ['.filo/.dirty', '.filo/rename-cascade-pending.json', '.filo/tag-rewrite-pending.json', '.filo/quit-failure.json']) {
        expect(() => assertNotInFiloDir(VAULT, bare)).toThrow(FiloDirForbiddenError);
      }
    });
  });

  // ── Normalisation: separators + case ────────────────────────────────
  describe('path normalisation', () => {
    it('rejects backslash-separated .filo paths (Windows-style)', () => {
      expect(() => assertNotInFiloDir(VAULT, '.filo\\app.json')).toThrow(FiloDirForbiddenError);
    });

    it('rejects mixed-separator .filo paths', () => {
      expect(() => assertNotInFiloDir(VAULT, '.filo\\sub/app.json')).toThrow(FiloDirForbiddenError);
    });

    it('rejects .FILO case variant (case-insensitive first-segment match)', () => {
      expect(() => assertNotInFiloDir(VAULT, '.FILO/app.json')).toThrow(FiloDirForbiddenError);
    });
  });
});
