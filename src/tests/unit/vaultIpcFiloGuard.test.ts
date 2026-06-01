import { describe, it, expect } from 'vitest';
import {
  assertNotInFiloDir,
  FiloDirForbiddenError,
} from '../../main/utils/pathSecurity';

/**
 * Phase 1 / 1.2 — every generic `vault:*` IPC handler that mutates the
 * filesystem (write-file-text, write-existing-file-text, delete, rename,
 * copy-file, create-folder) now runs the path it was handed through
 * `assertNotInFiloDir` so a buggy renderer cannot end-run the dedicated
 * `config:save` / `tags:save` / `templates:write` / `theme:save` channels
 * and clobber `.filo/` state with arbitrary text.
 *
 * The 8 cases below mirror the 6 IPC handlers (rename + copy-file each
 * check both endpoints, hence 8). Recovery sentinels remain allowlisted
 * inside the helper because `dirtyFlagRecovery` / `renameCascadeSentinel`
 * / `tagRewriteSentinel` legitimately go through `vault:write-file-text`.
 */
describe('vault IPC `.filo/` guard — assertNotInFiloDir', () => {
  it('throws FORBIDDEN for vault:write-file-text → ".filo/app.json"', () => {
    expect(() => assertNotInFiloDir('.filo/app.json')).toThrow(FiloDirForbiddenError);
    expect(() => assertNotInFiloDir('.filo/app.json')).toThrow(/FORBIDDEN/);
  });

  it('throws FORBIDDEN for vault:write-existing-file-text → ".filo/defaults.json"', () => {
    expect(() => assertNotInFiloDir('.filo/defaults.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:delete → ".filo/tags.json"', () => {
    // delete handler computes `relative(vaultRoot, itemPath)` and feeds
    // it to assertNotInFiloDir; the rel path here mimics that result.
    expect(() => assertNotInFiloDir('.filo/tags.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:rename source → ".filo/old.json"', () => {
    expect(() => assertNotInFiloDir('.filo/old.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:rename dest → ".filo/new.json"', () => {
    expect(() => assertNotInFiloDir('.filo/new.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:copy-file source → ".filo/cfg.json"', () => {
    // copy-file's source-inside-vault check feeds `relative(vault, src)`
    // when the source happens to live inside the vault — paths inside
    // `.filo/` are refused.
    expect(() => assertNotInFiloDir('.filo/cfg.json')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:copy-file dest → ".filo/copy.png"', () => {
    // copy-file's destination check feeds `{subfolder}/{basename(src)}`.
    expect(() => assertNotInFiloDir('.filo/copy.png')).toThrow(FiloDirForbiddenError);
  });

  it('throws FORBIDDEN for vault:create-folder → ".filo/subdir"', () => {
    expect(() => assertNotInFiloDir('.filo/subdir')).toThrow(FiloDirForbiddenError);
  });

  // ── Non-`.filo` paths pass through ──────────────────────────────────
  describe('legitimate vault paths are permitted', () => {
    it('permits a plain markdown file at vault root', () => {
      expect(() => assertNotInFiloDir('Notes.md')).not.toThrow();
    });

    it('permits a nested attachment path', () => {
      expect(() => assertNotInFiloDir('attachments/2026/photo.png')).not.toThrow();
    });

    it('permits a board file path', () => {
      expect(() => assertNotInFiloDir('Kanban/MyBoard/foo.board.json')).not.toThrow();
    });

    it('permits a folder name that merely STARTS with .filo (not equal)', () => {
      // First-segment EQUALITY check — a folder called `.filosophy` is
      // not the same as `.filo` and must pass.
      expect(() => assertNotInFiloDir('.filosophy/Notes.md')).not.toThrow();
    });

    it('permits an empty / null input (upstream validators handle those)', () => {
      expect(() => assertNotInFiloDir('')).not.toThrow();
      expect(() => assertNotInFiloDir(null as unknown as string)).not.toThrow();
      expect(() => assertNotInFiloDir(undefined as unknown as string)).not.toThrow();
    });
  });

  // ── Recovery sentinel allowlist ─────────────────────────────────────
  describe('recovery sentinels remain permitted (allowlist)', () => {
    it('permits .filo/.dirty (dirty-flag sentinel)', () => {
      expect(() => assertNotInFiloDir('.filo/.dirty')).not.toThrow();
    });

    it('permits .filo/rename-cascade-pending.json (rename sentinel)', () => {
      expect(() => assertNotInFiloDir('.filo/rename-cascade-pending.json')).not.toThrow();
    });

    it('permits .filo/tag-rewrite-pending.json (tag-rewrite sentinel)', () => {
      expect(() => assertNotInFiloDir('.filo/tag-rewrite-pending.json')).not.toThrow();
    });

    it('permits .filo/quit-failure.json (6.2.H4 quit-failure breadcrumb)', () => {
      expect(() => assertNotInFiloDir('.filo/quit-failure.json')).not.toThrow();
    });
  });

  // ── Normalisation: separators + case ────────────────────────────────
  describe('path normalisation', () => {
    it('rejects backslash-separated .filo paths (Windows-style)', () => {
      expect(() => assertNotInFiloDir('.filo\\app.json')).toThrow(FiloDirForbiddenError);
    });

    it('rejects mixed-separator .filo paths', () => {
      expect(() => assertNotInFiloDir('.filo\\sub/app.json')).toThrow(FiloDirForbiddenError);
    });

    it('rejects .FILO case variant (case-insensitive first-segment match)', () => {
      expect(() => assertNotInFiloDir('.FILO/app.json')).toThrow(FiloDirForbiddenError);
    });
  });
});
