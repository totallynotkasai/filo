import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { detectType, valueForRow, type PropType } from '@renderer/lib/utils/propertyRowTypes';
import { diffToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-10 B1 — the Properties popup coerced every frontmatter value through the
 * typed-row pipeline (`detectType` → `valueForRow`). A nested object became
 * `"[object Object]"` and a numeric/boolean array became strings, so editing ONE
 * unrelated property (e.g. `status`) and saving wrote the corrupted value of an
 * UNTOUCHED key into the delta. The `raw` row holds non-representable values
 * verbatim, so they stay out of the delta and survive on disk byte-for-byte.
 *
 * These tests reproduce the popup's exact row round-trip with the SHARED pure
 * helpers, build the same delta the popup builds, then queue it on the note
 * store (which applies it to a fresh read of the file) and assert the bytes on
 * disk. Reverting `detectType`'s `raw` branch turns the "nested map / numeric
 * list survived" assertions red.
 */

interface Row {
  key: string;
  type: PropType;
  value: unknown;
}

/** Mirror of PropertiesPopup.rowsFromObject — the exact corruption seam. */
function rowsFromObject(obj: Record<string, unknown>): Row[] {
  return Object.entries(obj).map(([key, value]) => {
    const type = detectType(key, value);
    return { key, type, value: valueForRow(value, type) };
  });
}

/** Mirror of PropertiesPopup.rowsToObject. */
function rowsToObject(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  return out;
}

describe('Audit-10 B1 — Properties popup round-trip preserves non-scalar FM (delta level)', () => {
  it('editing only status leaves a nested object + numeric array OUT of the delta', () => {
    const diskFm = {
      coordinates: { lat: 5, lng: 6 },
      years: [2024, 2025],
      status: 'todo',
    };
    // Popup open: build rows (this is where the OLD code coerced lossily).
    const rows = rowsFromObject(diskFm);
    // Sanity: the structured values were classified `raw`, not text/list.
    expect(rows.find((r) => r.key === 'coordinates')?.type).toBe('raw');
    expect(rows.find((r) => r.key === 'years')?.type).toBe('raw');

    // User edits ONLY the status row.
    const statusRow = rows.find((r) => r.key === 'status')!;
    statusRow.value = 'done';

    const before = JSON.parse(JSON.stringify(diskFm)) as Record<string, unknown>;
    const after = rowsToObject(rows);
    const delta = diffToFrontmatterDelta(before, after);

    // Only the touched key is in the delta; the structured keys are untouched.
    expect(delta.set).toEqual({ status: 'done' });
    expect(delta.unset).toEqual([]);
    // And the round-tripped values are still the real structures (not coerced).
    expect(after.coordinates).toEqual({ lat: 5, lng: 6 });
    expect(after.years).toEqual([2024, 2025]);
  });
});

describe('Audit-10 B1 — popup edit → note write preserves nested map + numeric array (disk bytes)', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  function lastWrite(rel: string): string | undefined {
    return vault.writes.filter(([, r]) => r === rel).at(-1)?.[2];
  }

  it('a status edit keeps a nested map + numeric list byte-for-byte on disk', async () => {
    const relPath = 'Place.md';
    const disk =
      '---\ncoordinates:\n  lat: 5\n  lng: 6\nyears:\n  - 2024\n  - 2025\nstatus: todo\n---\nbody\n';
    vault = installMemoryVault({ [relPath]: disk });

    // The parsed-from-disk FM the popup would load.
    const diskFm = {
      coordinates: { lat: 5, lng: 6 },
      years: [2024, 2025],
      status: 'todo',
    };
    const rows = rowsFromObject(diskFm);
    rows.find((r) => r.key === 'status')!.value = 'done';
    const before = JSON.parse(JSON.stringify(diskFm)) as Record<string, unknown>;
    const after = rowsToObject(rows);
    const delta = diffToFrontmatterDelta(before, after);

    noteStore.patchFrontmatter(relPath, delta);
    await noteStore.flush(relPath);

    const written = lastWrite(relPath)!;
    expect(written).toContain('status: done'); // the edit landed
    expect(written).not.toContain('status: todo');
    // The untouched structured values survived on disk, uncoerced.
    expect(written).toContain('lat: 5');
    expect(written).toContain('lng: 6');
    expect(written).toContain('- 2024');
    expect(written).toContain('- 2025');
    expect(written).not.toContain('[object Object]');
    expect(written).toContain('body');
  });

  it('adding a new scalar key preserves an untouched numeric array', async () => {
    const relPath = 'Nums.md';
    vault = installMemoryVault({ [relPath]: '---\nyears:\n  - 2024\n  - 2025\n---\nbody\n' });

    const diskFm = { years: [2024, 2025] };
    const rows = rowsFromObject(diskFm);
    rows.push({ key: 'reviewed', type: 'text', value: 'yes' });
    const before = JSON.parse(JSON.stringify(diskFm)) as Record<string, unknown>;
    const after = rowsToObject(rows);
    const delta = diffToFrontmatterDelta(before, after);

    noteStore.patchFrontmatter(relPath, delta);
    await noteStore.flush(relPath);

    const written = lastWrite(relPath)!;
    expect(written).toContain('reviewed: yes');
    expect(written).toContain('- 2024');
    expect(written).toContain('- 2025');
    expect(written).not.toContain("'2024'"); // not stringified
    expect(written).not.toContain('[object Object]');
  });
});
