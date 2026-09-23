import { describe, it, expect } from 'vitest';
import { UpdateCardFieldCommand } from '@renderer/commands/kanbanCommands';

/**
 * Audit-15 Phase 2 — data-path LOW parity (the sibling-parity sweep).
 *
 * Focused regression guards for the Phase-2 items whose fixes are most at risk
 * of silently regressing. The data-affecting items have their own behavioral
 * suites: P2.2 (gateway re-read) in `audit10Phase2.test.ts`, P2.7 (descendant
 * rebind) in `boardPathCaseFold.test.ts`.
 */
describe('Audit-15 Phase 2 — data-path LOW parity', () => {
  describe('P2.6 — UpdateCardFieldCommand requires a non-null docId', () => {
    it('throws when constructed with a null docId (chokepoint mirrors UpdateTaskFieldCommand 6.2.H7)', () => {
      // The old command carried a dead null-docId branch that scheduled a
      // no-delta write → the gateway re-emitted the unchanged FM, so Apply AND
      // Undo were silent no-ops. Both production callers route a null docId
      // through UpdateOrphanFrontmatterCommand; this throw stops a new caller
      // from re-introducing the silent loss.
      expect(
        () =>
          new UpdateCardFieldCommand(
            'board-1',
            'Card.md',
            null,
            { priority: 'high' },
            { priority: '' },
          ),
      ).toThrow(/non-null docId/);
    });

    it('constructs normally with a non-null docId', () => {
      expect(
        () =>
          new UpdateCardFieldCommand(
            'board-1',
            'Card.md',
            'doc-1',
            { priority: 'high' },
            { priority: '' },
          ),
      ).not.toThrow();
    });
  });
});
