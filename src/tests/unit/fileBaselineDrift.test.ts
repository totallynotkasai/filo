/**
 * fileBaselineDrift (Phase R6) — pre-write stat drift detection.
 *
 * NOTE (Audit-19 ERR-1): this file unit-tests the drift LOGIC with stubbed
 * sizes. The authority on real on-disk sizes is
 * boardFileEncodingRoundTrip.test.ts (real main-side board IO + real fs.stat).
 *
 * Phase R6 of the architectural refactor plan closes the
 * silent-external-edit-loss path that the legacy time-windowed
 * suppression introduced: when Filo wrote `Notes.md`, any external edit
 * landing inside the 1.5–5 s suppression window was silently swallowed
 * by the watcher and overwritten by the atomic write. The fix:
 * `writeMarkdownFile` (and the board / config writers) issue a
 * `vault:stat` immediately before the disk write and compare the result
 * against a per-file baseline captured at hydrate / load / last-self-
 * write. A mismatch routes through the Reload / Keep-local prompt
 * instead of silently clobbering.
 *
 * This suite locks down the four scenarios that matter:
 *  1. baseline match → write proceeds cleanly (no spurious drift toast)
 *  2. baseline mismatch → prompt handler invoked
 *  3. handler returns 'reload' → write aborted
 *  4. handler returns 'keep-local' → write proceeds
 *
 * Plus a self-write echo regression guard — successful writes refresh
 * the baseline to the post-write mtime so the next debounced write
 * doesn't falsely flag the prior write as external drift.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markHydrated,
  writeMarkdownFile,
  setExternalEditPromptHandler,
  __resetMarkdownFileWriterForTests,
} from '../../renderer/lib/vault/markdownFileWriter';
import {
  noteBaseline,
  getBaseline,
  __resetBaselinesForTests,
} from '../../renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/boardSaver';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '../../renderer/lib/boards/frontmatterWriteScheduler';
import { documentStore } from '../../renderer/stores/document.svelte';
import { vaultStore } from '../../renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface InvokeArgs {
  channel: string;
  args: unknown[];
}

interface FiloStubOptions {
  /** Sequence of mtimes to return from `vault:stat` (round-robins past the end). */
  statMtimes?: number[];
  /**
   * Sequence of sizes to return from `vault:stat` (round-robins past the
   * end, independently of `statMtimes`). Defaults to a constant 100 so
   * mtime-only tests keep size matching and exercise the mtime axis alone.
   */
  statSizes?: number[];
  /** Optional handler invoked per IPC; return value overrides defaults. */
  intercept?: (channel: string, args: unknown[]) => unknown;
}

function installFiloStub(opts: FiloStubOptions = {}): InvokeArgs[] {
  const captured: InvokeArgs[] = [];
  let statCallIdx = 0;
  // Audit-7 L5 — once a write lands, post-write stats must reflect the exact
  // bytes we wrote: the gateway's TOCTOU guard only refreshes the baseline when
  // the post-write stat's size matches `writtenByteLength`. Modelling a fixed
  // size here (the pre-L5 behaviour) would make every clean write look like a
  // foreign edit. Pre-write / recheck stats still use `statSizes` so the
  // size-drift scenarios keep working; only post-write stats track the write.
  let lastWrittenBytes: number | null = null;
  // Audit-17 5.3 — the gateway's post-write baseline guard now reads the bytes
  // BACK (vault:read-file-text) and stamps only on a byte-exact self-write. These
  // cache-less writes (no note path) issue no PRE-write read, so the only read-file-text here is
  // that post-write read-back; model it returning exactly what we wrote so a clean
  // self-write confirms (a `vault:stat` size match alone no longer stamps).
  let lastWrittenText: string | null = null;
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:write-existing-file-text') {
        lastWrittenText = String(args[2]);
        lastWrittenBytes = new TextEncoder().encode(lastWrittenText).length;
      }
      if (opts.intercept) {
        const result = opts.intercept(channel, args);
        if (result !== undefined) return result;
      }
      if (channel === 'vault:read-file-text' && lastWrittenText !== null) {
        return { success: true, content: lastWrittenText, mtimeMs: 1, size: lastWrittenBytes };
      }
      if (channel === 'vault:stat') {
        const mtimes = opts.statMtimes ?? [1000];
        const sizes = opts.statSizes ?? [100];
        const mtime = mtimes[statCallIdx % mtimes.length];
        const size = sizes[statCallIdx % sizes.length];
        statCallIdx++;
        if (lastWrittenBytes !== null) {
          return { success: true, mtimeMs: mtime, size: lastWrittenBytes };
        }
        return { success: true, mtimeMs: mtime, size };
      }
      // Default: every IPC succeeds.
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

/**
 * Byte length of the content passed to `vault:write-existing-file-text` — the
 * size a clean post-write stat reports, which the Audit-7 L5 baseline guard
 * requires the post-write stat to match. Tests assert the refreshed baseline's
 * size against this instead of a hard-coded number.
 */
function writtenByteLength(invokes: InvokeArgs[]): number {
  const write = invokes.find((i) => i.channel === 'vault:write-existing-file-text');
  return new TextEncoder().encode(String(write?.args[2] ?? '')).length;
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

describe('fileBaselineRegistry — pre-write drift detection', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    setExternalEditPromptHandler(null);
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    setExternalEditPromptHandler(null);
    uninstallFiloStub();
  });

  it('writes proceed when on-disk mtime matches baseline (self-write happy path)', async () => {
    const invokes = installFiloStub({ statMtimes: [1000, 1100] });
    const relPath = 'Notes/clean.md';
    // Hydrate with mtime baseline 1000. Pre-write stat returns 1000 →
    // match → write proceeds. Post-write stat returns 1100 → baseline
    // refreshes for the next round.
    markHydrated(relPath, false, 1000, 100);
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1000, size: 100 });

    let promptCalled = 0;
    setExternalEditPromptHandler(async () => {
      promptCalled++;
      return 'reload';
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'fresh',
      callerId: 'happy',
      notePath: null,
    });

    expect(promptCalled).toBe(0);
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // Baseline refreshed to the post-write stat (size = the bytes we wrote;
    // Audit-7 L5 only stamps when the post-write stat size matches).
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1100, size: writtenByteLength(invokes) });
  });

  it('drift detected → prompt handler invoked, Reload aborts write', async () => {
    // Pre-write stat returns 2000 (mtime moved since hydrate baseline 1000).
    // External edit landed in the gap.
    const invokes = installFiloStub({ statMtimes: [2000] });
    const relPath = 'Notes/drifted.md';
    markHydrated(relPath, false, 1000, 100);

    let promptCalled = 0;
    setExternalEditPromptHandler(async (path) => {
      promptCalled++;
      expect(path).toBe(relPath);
      return 'reload';
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'about to clobber external edit',
      callerId: 'drifted',
      notePath: null,
    });

    expect(promptCalled).toBe(1);
    // Reload was selected → no write IPC issued.
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(false);
    // Baseline NOT refreshed since the write was aborted; the prompt
    // handler is responsible for any post-Reload bookkeeping (e.g. the
    // Reload branch of promptExternalEditOnSync re-hydrates via
    // markHydrated which re-stamps the baseline).
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1000, size: 100 });
  });

  it('drift detected → Keep-local proceeds with write, baseline refreshes', async () => {
    // Pre-write stat 2000 (drift). 6.4.M13 — after Keep-local the writer
    // re-stats to confirm no SECOND drift landed while the modal was open;
    // that recheck returns 2000 (stable) so the write proceeds. Post-write
    // stat returns 2100 (our overwrite landed).
    // Audit-19 UX-6 — the keep-local backup adds one more stable stat (2000).
    const invokes = installFiloStub({ statMtimes: [2000, 2000, 2000, 2100] });
    const relPath = 'Notes/keeplocal.md';
    markHydrated(relPath, false, 1000, 100);

    setExternalEditPromptHandler(async () => 'keep-local');

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'overwriting external edit on purpose',
      callerId: 'keeplocal',
      notePath: null,
    });

    // Write IPC fired (the user chose Keep-local).
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // Baseline refreshed to the post-write mtime (size = the bytes we wrote).
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 2100, size: writtenByteLength(invokes) });
  });

  it('drift detected on SIZE change alone, same mtime (coarse-mtime collision guard)', async () => {
    // The whole point of tracking (mtime + size): on a coarse-mtime
    // filesystem (FAT/exFAT, many SMB/NFS shares, some cloud mounts) an
    // external edit can land in the same clock second as our last write,
    // leaving the mtime unchanged — but a content edit almost always
    // changes the byte length. Baseline {1000, 100}; pre-write stat
    // {1000, 250} → same mtime, different size → drift, prompt fires.
    // A pure mtime check (the old behaviour) would have silently clobbered.
    // 6.4.M13 — both pre-write (250) and the Keep-local recheck (250) stats
    // report the drifted size; the post-write stat reports the bytes we wrote
    // (Audit-7 L5), so `statSizes` only needs the two pre-write values.
    const invokes = installFiloStub({ statMtimes: [1000], statSizes: [250, 250] });
    const relPath = 'Notes/same-second.md';
    markHydrated(relPath, false, 1000, 100);

    let promptCalled = 0;
    setExternalEditPromptHandler(async (path) => {
      promptCalled++;
      expect(path).toBe(relPath);
      return 'keep-local';
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'overwriting a same-second external edit on purpose',
      callerId: 'same-second',
      notePath: null,
    });

    expect(promptCalled).toBe(1);
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // Keep-local proceeded → baseline refreshed to the post-write stat
    // (size = the bytes we wrote).
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1000, size: writtenByteLength(invokes) });
  });

  it('no baseline → drift check skipped (legacy unguarded behaviour)', async () => {
    // markHydrated without mtime → no baseline stamped.
    const invokes = installFiloStub({ statMtimes: [9999] });
    const relPath = 'Notes/no-baseline.md';
    markHydrated(relPath, false); // no mtime
    expect(getBaseline(relPath)).toBeUndefined();

    let promptCalled = 0;
    setExternalEditPromptHandler(async () => {
      promptCalled++;
      return 'reload';
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'no baseline = no drift check',
      callerId: 'no-baseline',
      notePath: null,
    });

    // Drift check skipped entirely (no pre-write stat issued either).
    expect(promptCalled).toBe(0);
    const preWriteStats = invokes.filter((i) => i.channel === 'vault:stat');
    // Only the post-write stat fires (to seed the baseline going forward).
    expect(preWriteStats.length).toBe(1);
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // Post-write stat seeded the baseline (size = the bytes we wrote).
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 9999, size: writtenByteLength(invokes) });
  });

  it('successful self-write refreshes baseline (no spurious drift on next write)', async () => {
    // Three consecutive writes from the same caller — each should refresh
    // the baseline so the next write sees baseline == disk-mtime.
    installFiloStub({ statMtimes: [1000, 1100, 1100, 1200, 1200, 1300] });
    const relPath = 'Notes/multi-write.md';
    markHydrated(relPath, false, 1000, 100);

    let promptCalled = 0;
    setExternalEditPromptHandler(async () => {
      promptCalled++;
      return 'reload';
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'write 1',
      callerId: 'multi',
      notePath: null,
    });
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'write 2',
      callerId: 'multi',
      notePath: null,
    });
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'write 3',
      callerId: 'multi',
      notePath: null,
    });

    // No prompt fired across three writes — each write's post-write
    // stat refreshed the baseline to the next pre-write stat's value,
    // so drift check sees match every time.
    expect(promptCalled).toBe(0);
  });

  it('DI-14 — post-write stat failure KEEPS the prior baseline (no silent-overwrite window)', async () => {
    // Baseline {1000,100}. Pre-write drift stat (1st) matches → write proceeds.
    // Post-write refresh stat (2nd) FAILS. Pre-DI-14 (6.4.M2) this CLEARED the
    // baseline → the next write would skip its drift check (silent-overwrite
    // window). DI-14 keeps the prior baseline so the drift check stays armed.
    let statCalls = 0;
    const invokes = installFiloStub({
      intercept: (channel) => {
        if (channel === 'vault:stat') {
          statCalls++;
          if (statCalls === 1) return { success: true, mtimeMs: 1000, size: 100 };
          // Post-write stat fails (AV / SMB / VFS hiccup).
          return { success: false, code: 'EIO' };
        }
        return undefined;
      },
    });
    const relPath = 'Notes/stat-fail.md';
    markHydrated(relPath, false, 1000, 100);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'write whose post-write stat fails',
      callerId: 'di14',
      notePath: null,
    });

    // The write landed (post-write stat fires only after a successful write).
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // DI-14: baseline KEPT, not cleared.
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1000, size: 100 });
  });

  it('DI-09 — concurrent writes to the same path serialize across callerIds', async () => {
    // A TextTile (`text-tile:1`) and a DocumentEditor (`document-editor:1`)
    // write the SAME .md concurrently. Without per-path chaining their write
    // IPCs interleave and the loser's bytes are clobbered; with it, the second
    // write's IPC starts only after the first fully settles.
    const events: string[] = [];
    let releaseA: (() => void) | null = null;
    installFiloStub({
      intercept: (channel, args) => {
        if (channel === 'vault:write-existing-file-text') {
          const content = String(args[2]);
          if (content.includes('AAA')) {
            events.push('A:start');
            return new Promise((resolve) => {
              releaseA = () => {
                events.push('A:done');
                resolve({ success: true });
              };
            });
          }
          if (content.includes('BBB')) {
            events.push('B:start');
            return { success: true };
          }
        }
        return undefined;
      },
    });
    const relPath = 'Notes/shared.md';
    markHydrated(relPath, false); // no baseline → skip the pre-write drift stat

    const pA = writeMarkdownFile({
      vaultRoot: '/vault', relPath, frontmatter: {}, body: 'AAA',
      callerId: 'text-tile:1', notePath: null,
    });
    const pB = writeMarkdownFile({
      vaultRoot: '/vault', relPath, frontmatter: {}, body: 'BBB',
      callerId: 'document-editor:1', notePath: null,
    });

    // Let A reach (and hang at) its write IPC. B must be queued behind A's
    // chain and not have started its own write IPC yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['A:start']);

    releaseA!();
    await Promise.all([pA, pB]);
    // B's write IPC fired only after A fully completed.
    expect(events).toEqual(['A:start', 'A:done', 'B:start']);
  });

  it('handler unregistered → drift falls through as Keep-local (proceeds with write)', async () => {
    // External-edit handler NOT installed (matches the bootstrap window
    // before vaultExternalChanges has registered, or test environments
    // that don't load the store layer).
    // 6.4.M13 — middle 2000 is the Keep-local recheck stat (stable); 2100 is
    // the post-write stat. With no handler, drift falls through as Keep-local.
    const invokes = installFiloStub({ statMtimes: [2000, 2000, 2100] });
    const relPath = 'Notes/no-handler.md';
    markHydrated(relPath, false, 1000, 100);
    // Explicitly clear any handler the test harness might have set.
    setExternalEditPromptHandler(null);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'no handler',
      callerId: 'no-handler',
      notePath: null,
    });

    // Write IPC fired — legacy behaviour preserved when no handler.
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
  });
});

describe('fileBaselineRegistry — case-insensitive lookups', () => {
  beforeEach(() => __resetBaselinesForTests());
  afterEach(() => __resetBaselinesForTests());

  it('exposes noteBaseline/getBaseline/clearBaseline contract', () => {
    expect(getBaseline('Notes/x.md')).toBeUndefined();
    noteBaseline('Notes/x.md', 1234, 100);
    expect(getBaseline('Notes/x.md')).toMatchObject({ mtimeMs: 1234, size: 100 });
    noteBaseline('Notes/x.md', 5678, 200);
    expect(getBaseline('Notes/x.md')).toMatchObject({ mtimeMs: 5678, size: 200 });
  });

  it('rejects non-finite mtimes (NaN, Infinity)', () => {
    noteBaseline('Notes/y.md', NaN, 100);
    expect(getBaseline('Notes/y.md')).toBeUndefined();
    noteBaseline('Notes/y.md', Infinity, 100);
    expect(getBaseline('Notes/y.md')).toBeUndefined();
  });

  it('rejects non-finite sizes (NaN, Infinity) — never seeds a half-populated baseline', () => {
    noteBaseline('Notes/s.md', 1000, NaN);
    expect(getBaseline('Notes/s.md')).toBeUndefined();
    noteBaseline('Notes/s.md', 1000, Infinity);
    expect(getBaseline('Notes/s.md')).toBeUndefined();
  });

  it('rejects empty path / null mtime / null size', () => {
    noteBaseline('', 1000, 100);
    expect(getBaseline('')).toBeUndefined();
    noteBaseline('Notes/z.md', null as unknown as number, 100);
    expect(getBaseline('Notes/z.md')).toBeUndefined();
    noteBaseline('Notes/z2.md', 1000, null as unknown as number);
    expect(getBaseline('Notes/z2.md')).toBeUndefined();
  });
});

/**
 * F1 (2026-05-28) — read-driven hydrate seeds the drift baseline.
 *
 * The gateway-level suite above proves the drift check WORKS once a baseline
 * is seeded (it calls `markHydrated(rel, false, 1000)` directly). The gap F1
 * closes is that no real hydrate site passed the mtime, so the baseline was
 * never seeded at hydrate time and the first post-hydrate write silently
 * clobbered any external edit.
 *
 * This suite exercises a real hydrate→write path end-to-end: the frontmatter
 * scheduler reads disk to detect a BOM for a never-hydrated file, then writes.
 * That read now returns `mtimeMs` (extended `vault:read-file-text`), which the
 * scheduler threads into `markHydrated`. With the baseline seeded, an external
 * mtime bump landing between the read and the write routes through the
 * Reload / Keep-local prompt instead of overwriting silently.
 *
 * The frontmatter scheduler is the cleanest representative: like the
 * TextTile / DocumentEditor / properties / kanban-orphan paths it has no
 * pre-write guard of its own, so the gateway baseline is the only defence —
 * and unlike those it's a pure async lib function with no Svelte mount.
 */
describe('F1 — read-driven hydrate seeds the drift baseline', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    setExternalEditPromptHandler(null);
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    setExternalEditPromptHandler(null);
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('external mtime bump between the hydrate read and the write fires the prompt', async () => {
    // The BOM-detection read returns mtime 1000 → seeds the baseline. The
    // gateway's pre-write stat returns 2000 → an external editor wrote in
    // the gap. Pre-F1 (markHydrated with no mtime) the baseline was
    // undefined, the drift check no-opped, and the external edit was
    // silently overwritten — promptCalls would be 0.
    const relPath = 'Notes/fm-drift.md';
    let promptCalls = 0;
    setExternalEditPromptHandler(async (path) => {
      promptCalls++;
      expect(path).toBe(relPath);
      return 'keep-local';
    });

    // Audit-7 L5 — the post-write stat must report the bytes we wrote for the
    // baseline to refresh (a fixed size would read as a foreign edit and be
    // rejected). Track the written length; pre-write / recheck stats (before
    // the write) keep the external mtime bump that drives the drift.
    let writtenLen = 0;
    let writtenText = '';
    installFiloMock({
      // Audit-17 5.3 — pre-write reads (hydrate / delta fresh-read) return the
      // original disk content; the post-write read-back (after the write fired)
      // must return the bytes we wrote so the baseline-refresh guard confirms.
      'vault:read-file-text': () =>
        writtenLen > 0
          ? { success: true, content: writtenText, mtimeMs: 2000, size: writtenLen }
          : { success: true, content: '---\ncompleted: false\n---\nbody', mtimeMs: 1000, size: 100 },
      'vault:stat': () =>
        writtenLen > 0
          ? { success: true, mtimeMs: 2000, size: writtenLen }
          : { success: true, mtimeMs: 2000, size: 100 },
      'vault:write-existing-file-text': (...args: unknown[]) => {
        writtenText = String(args[2]);
        writtenLen = new TextEncoder().encode(writtenText).length;
        return { success: true };
      },
      'vault:file-exists': () => true,
    });

    documentStore.loadDocument({
      filename: relPath,
      title: 'Note',
      body: 'body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { completed: true });

    scheduleFrontmatterWrite(relPath, relPath);
    await flushAllPendingFrontmatterWrites();

    expect(promptCalls).toBe(1);
    // Keep-local proceeded → post-write stat refreshed the baseline.
    expect(writtenLen).toBeGreaterThan(0);
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 2000, size: writtenLen });
  });

  it('matching mtime does not spuriously prompt (no false positive on self-write)', async () => {
    // Read mtime 1000 == pre-write stat 1000 → no external edit → no prompt.
    const relPath = 'Notes/fm-clean.md';
    let promptCalls = 0;
    setExternalEditPromptHandler(async () => {
      promptCalls++;
      return 'reload';
    });

    // Audit-7 L5 — post-write stat reports the bytes we wrote so the baseline
    // refreshes cleanly (a fixed size would read as foreign and be rejected).
    let writtenLen = 0;
    let writtenText = '';
    installFiloMock({
      // Audit-17 5.3 — post-write read-back returns the bytes we wrote (pre-write
      // reads return the original disk content) so the self-write baseline refresh
      // confirms.
      'vault:read-file-text': () =>
        writtenLen > 0
          ? { success: true, content: writtenText, mtimeMs: 1000, size: writtenLen }
          : { success: true, content: '---\ncompleted: false\n---\nbody', mtimeMs: 1000, size: 100 },
      'vault:stat': () =>
        writtenLen > 0
          ? { success: true, mtimeMs: 1000, size: writtenLen }
          : { success: true, mtimeMs: 1000, size: 100 },
      'vault:write-existing-file-text': (...args: unknown[]) => {
        writtenText = String(args[2]);
        writtenLen = new TextEncoder().encode(writtenText).length;
        return { success: true };
      },
      'vault:file-exists': () => true,
    });

    documentStore.loadDocument({
      filename: relPath,
      title: 'Note',
      body: 'body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { completed: true });

    scheduleFrontmatterWrite(relPath, relPath);
    await flushAllPendingFrontmatterWrites();

    expect(promptCalls).toBe(0);
    expect(writtenLen).toBeGreaterThan(0);
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 1000, size: writtenLen });
  });
});
