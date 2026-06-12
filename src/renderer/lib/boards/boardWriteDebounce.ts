/**
 * Canonical 300ms idle-debounce window for board / config / .filo writes.
 *
 * CLAUDE.md treats the 300ms debounce as a contract: content edits,
 * layout changes, and config edits all coalesce on this window so a chatty
 * keystroke or pan/zoom stream doesn't translate into a write-per-event.
 * Sibling schedulers (`frontmatterWriteScheduler.FM_DEBOUNCE_MS`) match this
 * value for the same reason — diverging the windows would let interleaved
 * scheduling races land writes in the wrong order.
 *
 * Extracted from boardSaver into its own module so every scheduler
 * (board, config, misc, viewport) can read it without pulling in their
 * siblings.
 */

export const BOARD_WRITE_DEBOUNCE_MS = 300;

/**
 * Audit5 R3 / Audit-11 WC-1 — upper bound (ms) on a SINGLE debounced write,
 * passed to every scheduler's `createScheduler({ writeTimeoutMs })`. A wedged
 * write — a never-resolving external-edit drift prompt (#1), or a
 * `vault:*`/`config:*`/`board:*` IPC stuck on a dropped network volume
 * (OneDrive / SMB, the documented target environment) — must not hang an
 * awaiting `flushAll` / `vaultStore.save()` / quit forever. On elapse the
 * scheduler stops awaiting that write, marks its path failed (so `.filo/.dirty`
 * + the save indicator stay live), and attributes the failure so `save()`
 * returns false instead of freezing. The underlying write keeps running; a
 * late success self-heals via its own `trackComponentWrite` `endWrite`.
 *
 * 60s is deliberately well ABOVE any legitimate in-write await: the interactive
 * drift prompt auto-dismisses at the 15s toast cap (→ 'defer') and re-prompts at
 * most 3×, so a genuine user decision blocks a write for at most ~45s. The bound
 * therefore only ever fires on a TRULY wedged write, never on a slow-but-live
 * prompt. It is a backstop, not a latency budget.
 *
 * Lives here (a dependency-free leaf) rather than in `markdownFileWriter.ts` so
 * the board / config / misc / frontmatter schedulers can import it WITHOUT the
 * module-eval cycle (scheduler → markdownFileWriter → boardSaver → scheduler)
 * that would leave the const in the temporal dead zone at `createScheduler`
 * time. `markdownFileWriter` re-exports it as `MARKDOWN_WRITE_TIMEOUT_MS`.
 */
export const WRITE_TIMEOUT_MS = 60_000;

/**
 * Audit-17 5.4 — UTF-8 byte length of a payload string. The board/config writers
 * encode their payload as UTF-8, so this equals the on-disk byte size of a clean
 * self-write — used by their post-write baseline TOCTOU guards (mirroring the
 * markdown gateway's Audit-7 L5 check) to tell our own bytes from a foreign edit
 * that landed in the save→stat gap. Lives in this dependency-free leaf so every
 * scheduler can share one implementation.
 */
const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export function writtenByteLength(text: string): number {
  return utf8Encoder ? utf8Encoder.encode(text).length : text.length;
}
