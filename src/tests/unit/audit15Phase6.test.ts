import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { documentStore } from '@renderer/stores/document.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-15 P6.1 — scheduler quiescence-parity.
 *
 * `writeScheduler` has THREE independent places that decide "is this key /
 * scheduler quiescent?":
 *   1. flush(key) EARLY-RETURN      — pending ∅ AND inFlight ∅ AND parked ∅
 *   2. flush(key) DRAIN LOOP        — while (inFlight.size || parked.size)
 *   3. flushAll() PARKED-DRAIN LOOP — while (anyParked() || inFlight.size)
 *
 * P1.1 was a `parked`-BLIND early-return (#1): in the one-microtask gap where a
 * write is parked behind a just-settled in-flight write (pending + inFlight both
 * empty, parked NOT), a single-key flush (tab-close) returned {ok:true} before
 * the newest edit landed — a false "saved". The drain loop (#2) and flushAll (#3)
 * already checked `parked`; only the early-return missed it. That is the dominant
 * shape of bugs in this scheduler (a hardened path whose sibling missed the same
 * fix), so this suite pins that ALL THREE honor `parked` against the SAME
 * constructed state — a future edit can't fix/refactor one and leave a sibling
 * blind. Backs P1.1 + P2.5.
 *
 * `__parkForTests(key)` builds the otherwise production-unreachable isolated gap
 * (parked non-empty; pending + inFlight empty) directly, so flush() and flushAll()
 * are exercised against identical state and must agree.
 */

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Args {
  path: string;
}

function makeScheduler(name: string) {
  return createScheduler<Args>({
    name,
    debounceMs: 5,
    performWrite: () => Promise.resolve(),
    getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
  });
}

describe('Audit-15 P6.1 — scheduler quiescence parity (flush early-return, flush drain loop, flushAll all honor `parked`)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('flush(key) does not report done while a write is parked with empty pending/inFlight', async () => {
    const s = makeScheduler('p61-flush');
    const release = s.__parkForTests('k');

    let resolved = false;
    const p = s.flush('k').then((r) => {
      resolved = true;
      return r;
    });

    await tick();
    // Bite: a `parked`-blind early-return (P1.1) returns {ok:true} immediately.
    expect(resolved).toBe(false);

    release();
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.ok).toBe(true);
  }, 5000);

  it('flushAll() does not resolve while a write is parked with empty pending/inFlight (same isolated gap)', async () => {
    const s = makeScheduler('p61-flushall');
    const release = s.__parkForTests('k');

    let resolved = false;
    const p = s.flushAll().then((r) => {
      resolved = true;
      return r;
    });

    await tick();
    // Bite: a flushAll loop guarded only on `inFlight.size` (dropping
    // `anyParked()`) never enters and resolves immediately against this gap.
    expect(resolved).toBe(false);

    release();
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.failed).toEqual([]);
  }, 5000);

  it('P2.5 — hasPendingTimer is armed-timer-ONLY by design: a parked write is invisible to it', () => {
    // hasPendingTimer must NOT fold in parked/inFlight: those carry no args, and
    // including them would pin the gateway's post-write markClean caller dirty
    // forever (it asks "is a NEWER timer armed?"). Durability instead relies on
    // the sentinel ledger (isPathPending) + the flush/flushAll quiescence checks
    // above. This pins the deliberate divergence so a future "consistency" edit
    // doesn't make hasPendingTimer see parked and silently break markClean.
    const s = makeScheduler('p61-haspending');
    const release = s.__parkForTests('k');
    expect(s.hasPendingTimer(() => true)).toBe(false);
    release();
  });
});

/**
 * Audit-15 P6.5 — rawFrontmatter-threading coverage (backs P2.1).
 *
 * An external-edit RELOAD that calls `documentStore.setFrontmatter(path, fm)`
 * without the 3rd `rawFrontmatter` arg leaves `originalFrontmatterCache` at the
 * PRE-edit source (stale, not dropped — see `noteRawFrontmatter`). A later
 * body-only save then diffs the fresh FM against that stale baseline → an
 * external key's inline comment / quoting is lost or re-appended out of place.
 * P2.1 was one reload site (`promptPropertiesPopupModified`) that missed the
 * thread its 6 siblings had. This pins the behavioural LINK (threading refreshes
 * the baseline) AND, structurally, that EVERY setFrontmatter call in the
 * external-reload files threads the arg — so a future reload site can't omit it.
 */

/** Blank comment bodies, keeping string contents, so a commented-out / mentioned
 *  `setFrontmatter(` isn't scanned. Offsets preserved for line reporting. */
function blankComments(src: string): string {
  let out = '';
  let st: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { st = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i += 1; continue; }
      if (c === '"') { st = 'dq'; out += c; i += 1; continue; }
      if (c === '`') { st = 'tpl'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (st === 'block') {
      if (c === '*' && d === '/') { st = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    const q = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === q) { st = 'code'; out += c; i += 1; continue; }
    out += c; i += 1; continue;
  }
  return out;
}

/** Counts top-level args of a call whose `(` is at `openParen`. String/bracket
 *  aware; `()` → 0. */
function callArgCount(src: string, openParen: number): number {
  let depth = 0;
  let commas = 0;
  let sawNonWs = false;
  let str: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; sawNonWs = true; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && c === ',') { commas++; continue; }
    if (depth === 1 && !/\s/.test(c)) sawNonWs = true;
  }
  return sawNonWs ? commas + 1 : 0;
}

describe('Audit-15 P6.5 — rawFrontmatter threading refreshes originalFrontmatterCache; every reload site threads it', () => {
  it('threading rawFrontmatter REFRESHES the baseline; omitting it leaves a STALE one (the P2.1 reload bug)', () => {
    const notePath = 'P65.md';
    documentStore.setFrontmatter(notePath, { title: 'A' }, 'title: A\n');
    expect(documentStore.getOriginalFrontmatterSource(notePath)).toBe('title: A\n');

    // A reload that omits the 3rd arg does NOT refresh the baseline — it silently
    // STAYS at the pre-external-edit source, so a later body-only save diffs the
    // fresh FM against stale bytes. This is precisely why every reload site must
    // thread `next.rawFrontmatter` (P2.1).
    documentStore.setFrontmatter(notePath, { title: 'B' });
    expect(documentStore.getOriginalFrontmatterSource(notePath)).toBe('title: A\n');

    // Threading the new disk bytes refreshes it.
    documentStore.setFrontmatter(notePath, { title: 'B' }, 'title: B\n');
    expect(documentStore.getOriginalFrontmatterSource(notePath)).toBe('title: B\n');
  });

  it('every documentStore.setFrontmatter call in the external-reload files threads a rawFrontmatter (3rd) arg', () => {
    const dir = join(process.cwd(), 'src/renderer/stores');
    const files = readdirSync(dir).filter((f) => /^vaultExternal.*\.ts$/.test(f));
    let total = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const src = blankComments(readFileSync(join(dir, file), 'utf8'));
      const re = /\bsetFrontmatter\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        total++;
        const parenIdx = m.index + m[0].length - 1; // index of the call's `(`
        const args = callArgCount(src, parenIdx);
        if (args < 3) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(
            `${file}:${line} — setFrontmatter(...) has ${args} arg(s); a reload must thread ` +
              '(notePath, frontmatter, rawFrontmatter) so originalFrontmatterCache refreshes (P2.1)',
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    // Tripwire — the scan must keep finding the reload sites (2 today). A 0 means
    // the files were renamed and this coverage silently lapsed.
    expect(total).toBeGreaterThanOrEqual(2);
  });
});
