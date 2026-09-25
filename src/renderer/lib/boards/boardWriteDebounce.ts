/**
 * Canonical 300ms idle-debounce window for board / config / .filo writes.
 *
 * CLAUDE.md treats the 300ms debounce as a contract: content edits,
 * layout changes, and config edits all coalesce on this window so a chatty
 * keystroke or pan/zoom stream doesn't translate into a write-per-event.
 * Sibling schedulers (`noteWriter.NOTE_WRITE_DEBOUNCE_MS`) match this
 * value for the same reason — diverging the windows would let interleaved
 * scheduling races land writes in the wrong order.
 *
 * Extracted from boardSaver into its own module so every scheduler
 * (board, config, misc, viewport) can read it without pulling in their
 * siblings.
 */

export const BOARD_WRITE_DEBOUNCE_MS = 300;

/**
 * Upper bound (ms) on a SINGLE debounced write, passed to every scheduler's
 * `createScheduler({ writeTimeoutMs })`. A wedged write — a never-resolving
 * external-edit drift prompt, or a
 * `vault:*`/`config:*`/`board:*` IPC stuck on a dropped network volume
 * (OneDrive / SMB, the documented target environment) — must not hang an
 * awaiting `flushAll` / `vaultStore.save()` / quit forever. On elapse the
 * scheduler stops awaiting that write, marks its path failed (so `.filo/.dirty`
 * + the save indicator stay live), and attributes the failure so `save()`
 * returns false instead of freezing. The underlying write keeps running; a
 * late success self-heals via its own `trackComponentWrite` `endWrite`.
 *
 * 60s is deliberately well ABOVE any legitimate in-write await: the board
 * writer's interactive drift prompt auto-dismisses at the 15s toast cap (→
 * 'defer') and re-prompts at most 3×, so a genuine user decision blocks a
 * write for at most ~45s. The bound therefore only ever fires on a TRULY
 * wedged write, never on a slow-but-live prompt. It is a backstop, not a
 * latency budget.
 *
 * Lives here (a dependency-free leaf) so every scheduler, the note writer
 * included, can import it without a module-eval cycle through `boardSaver`
 * that would leave the const in the temporal dead zone at `createScheduler`
 * time. The note writer re-exports it as `NOTE_WRITE_TIMEOUT_MS`.
 */
export const WRITE_TIMEOUT_MS = 60_000;

/**
 * Grace delay (ms) before a scheduler's pre-write ENOENT re-stat. A sync
 * client's (OneDrive / Dropbox / AV) unlink→recreate blip during an armed write
 * usually completes within tens of ms; the delay gives the recreate time to land
 * so the re-stat SEES the file and the armed write falls through to the drift
 * check (a recreate carries a new mtime → drift → prompt) instead of treating
 * the gap as an intentional delete and silently dropping the debounce window's
 * mutations.
 *
 * Shared by the board AND config schedulers (re-exported by the board scheduler
 * as `BOARD_ENOENT_RESTAT_DELAY_MS`). Lives in this dependency-free leaf so both
 * import it without a cross-scheduler dependency. Kept far below
 * `WRITE_TIMEOUT_MS`.
 */
export const ENOENT_RESTAT_DELAY_MS = 150;

/**
 * UTF-8 byte length of a payload string. The board/config writers encode their
 * payload as UTF-8, so this equals the on-disk byte size of a clean self-write —
 * used by their post-write baseline TOCTOU guards (mirroring the markdown
 * gateway's check) to tell our own bytes from a foreign edit
 * that landed in the save→stat gap. Lives in this dependency-free leaf so every
 * scheduler can share one implementation.
 */
const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export function writtenByteLength(text: string): number {
  return utf8Encoder ? utf8Encoder.encode(text).length : text.length;
}
