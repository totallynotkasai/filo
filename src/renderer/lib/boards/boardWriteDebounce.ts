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
