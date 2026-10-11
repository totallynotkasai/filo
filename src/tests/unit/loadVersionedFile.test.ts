/**
 * `loadVersionedFile` is the single migrate-then-validate path every versioned
 * `.filo/` config loader routes through. These tests pin the four-way
 * classification and the migrate-before-parse ordering that a from-future file
 * relies on to avoid a silent downgrade.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  loadVersionedFile,
  type VersionMigrator,
} from '@renderer/lib/vault/loadVersionedFile';

const CURRENT = 2;

const Schema = z.object({
  version: z.number().int().default(CURRENT),
  label: z.string(),
});

/**
 * Minimal migrator mirroring the real `migrate*` scaffolds: stamp the
 * current version, flag from-future / no-migration-path, expose
 * `migratedFrom`.
 */
const migrate: VersionMigrator = (raw) => {
  const v =
    raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'number'
      ? (raw as { version: number }).version
      : null;
  if (v !== null && !Number.isInteger(v)) {
    return { data: raw, migratedFrom: v, fromFuture: false, noMigrationPath: true };
  }
  if (v === CURRENT) return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  if (v !== null && v > CURRENT) return { data: raw, migratedFrom: v, fromFuture: true, noMigrationPath: false };
  if (v !== null && v < 1) return { data: raw, migratedFrom: v, fromFuture: false, noMigrationPath: true };
  // v1 → v2: stamp the version forward.
  const start = v ?? 1;
  const next = raw && typeof raw === 'object' ? { ...(raw as object), version: CURRENT } : raw;
  return { data: next, migratedFrom: start, fromFuture: false, noMigrationPath: false };
};

describe('loadVersionedFile', () => {
  it('returns ok with parsed data for a current-version file', () => {
    const result = loadVersionedFile(Schema, migrate, { version: CURRENT, label: 'hi' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.label).toBe('hi');
      expect(result.migratedFrom).toBeNull();
    }
  });

  it('migrates a legacy version forward before parsing (migratedFrom set)', () => {
    const result = loadVersionedFile(Schema, migrate, { version: 1, label: 'legacy' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.version).toBe(CURRENT);
      expect(result.migratedFrom).toBe(1);
    }
  });

  it('classifies a from-future file without parsing (no silent downgrade)', () => {
    const result = loadVersionedFile(Schema, migrate, { version: 99, label: 'future' });
    expect(result.status).toBe('from-future');
    if (result.status === 'from-future') expect(result.migratedFrom).toBe(99);
  });

  it('classifies an un-migratable / fractional version as no-migration-path', () => {
    const result = loadVersionedFile(Schema, migrate, { version: 1.5, label: 'weird' });
    expect(result.status).toBe('no-migration-path');
    if (result.status === 'no-migration-path') expect(result.migratedFrom).toBe(1.5);
  });

  it('returns invalid (with the ZodError) when the migrated shape fails the schema', () => {
    const result = loadVersionedFile(Schema, migrate, { version: CURRENT /* label missing */ });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('applies the transform to the migrated object before validation', () => {
    const result = loadVersionedFile(
      Schema,
      migrate,
      { version: CURRENT, label: 'raw' },
      (data) => ({ ...(data as object), label: 'transformed' }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.data.label).toBe('transformed');
  });

  it('does NOT run the transform for from-future files (parse step is skipped)', () => {
    let transformRan = false;
    const result = loadVersionedFile(
      Schema,
      migrate,
      { version: 99, label: 'future' },
      (data) => {
        transformRan = true;
        return data;
      },
    );
    expect(result.status).toBe('from-future');
    expect(transformRan).toBe(false);
  });
});
