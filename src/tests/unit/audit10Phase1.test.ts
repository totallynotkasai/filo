import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { detectType, valueForRow, type PropType } from '@renderer/lib/utils/propertyRowTypes';
import { diffToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import {
  markHydrated,
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  cancelAllMarkdownWrites,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-10 B1 — the Properties popup coerced every frontmatter value through the
 * typed-row pipeline (`detectType` → `valueForRow`). A nested object became
 * `"[object Object]"` and a numeric/boolean array became strings, so editing ONE
 * unrelated property (e.g. `status`) and saving wrote the corrupted value of an
 * UNTOUCHED key into the delta. The `raw` row holds non-representable values
 * verbatim, so they stay out of the delta and survive on disk byte-for-byte.
 *
 * These tests reproduce the popup's exact row round-trip with the SHARED pure
 * helpers, build the same delta the popup builds, then drive the real write
 * gateway (`assembleMarkdownFile`) and assert the bytes on disk. Reverting
 * `detectType`'s `raw` branch turns the "nested map / numeric list survived"
 * assertions red.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string; // (vaultRoot, relPath, fileText)
    }
  }
  return undefined;
}

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

describe('Audit-10 B1 — popup edit → gateway write preserves nested map + numeric array (disk bytes)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 5, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  it('a status edit keeps a nested map + numeric list byte-for-byte on disk', async () => {
    const relPath = 'Place.md';
    const disk =
      '---\ncoordinates:\n  lat: 5\n  lng: 6\nyears:\n  - 2024\n  - 2025\nstatus: todo\n---\nbody\n';
    installDisk(disk);
    markHydrated(relPath, false);

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

    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath,
      frontmatter: after, // legacy fallback (ignored when a delta is present)
      body: 'body',
      callerId: `properties-popup:${relPath}`,
      notePath: relPath,
      frontmatterDelta: delta,
    });
    await flushMarkdownWrite(`properties-popup:${relPath}`);

    const written = lastWrite(captured)!;
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
    installDisk('---\nyears:\n  - 2024\n  - 2025\n---\nbody\n');
    markHydrated(relPath, false);

    const diskFm = { years: [2024, 2025] };
    const rows = rowsFromObject(diskFm);
    rows.push({ key: 'reviewed', type: 'text', value: 'yes' });
    const before = JSON.parse(JSON.stringify(diskFm)) as Record<string, unknown>;
    const after = rowsToObject(rows);
    const delta = diffToFrontmatterDelta(before, after);

    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath,
      frontmatter: after,
      body: 'body',
      callerId: `properties-popup:${relPath}`,
      notePath: relPath,
      frontmatterDelta: delta,
    });
    await flushMarkdownWrite(`properties-popup:${relPath}`);

    const written = lastWrite(captured)!;
    expect(written).toContain('reviewed: yes');
    expect(written).toContain('- 2024');
    expect(written).toContain('- 2025');
    expect(written).not.toContain("'2024'"); // not stringified
    expect(written).not.toContain('[object Object]');
  });
});
