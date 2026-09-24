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
  describe('P2.6 — UpdateCardFieldCommand requires a non-null notePath', () => {
    it('throws when constructed with a null notePath (chokepoint mirrors UpdateTaskFieldCommand 6.2.H7)', () => {
      // A null-notePath branch would schedule a no-delta write → the gateway
      // re-emits the unchanged FM, so Apply AND Undo would be silent no-ops. Both production callers route a null notePath
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
      ).toThrow(/non-null notePath/);
    });

    it('constructs normally with a non-null notePath', () => {
      expect(
        () =>
          new UpdateCardFieldCommand(
            'board-1',
            'Card.md',
            'Card.md',
            { priority: 'high' },
            { priority: '' },
          ),
      ).not.toThrow();
    });
  });
});
