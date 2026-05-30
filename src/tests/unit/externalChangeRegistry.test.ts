/**
 * Phase 3 / 3.2 — externalChangeRegistry unit tests.
 *
 * Pure dispatcher logic: register reconcilers, dispatch events, batched
 * dispatch. No store coordination — that's the integration concern of
 * the per-reconciler tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerReconciler,
  registerBatchedReconciler,
  dispatchExternalChange,
  dispatchExternalChangeBatch,
  _resetRegistryForTests,
  _registeredKindsForTests,
  type ExternalChangeEvent,
  type ExternalChangeReconciler,
  type BatchedReconciler,
} from '../../renderer/lib/vault/externalChangeRegistry';

describe('externalChangeRegistry', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  describe('registerReconciler / dispatchExternalChange', () => {
    it('routes an event to its kind-specific reconciler', async () => {
      const handle = vi.fn();
      const reconciler: ExternalChangeReconciler = {
        kind: 'board',
        handle,
      };
      registerReconciler(reconciler);

      const event: ExternalChangeEvent = {
        kind: 'board',
        filename: 'sample.board.json',
        eventType: 'change',
      };
      await dispatchExternalChange(event);

      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(event);
    });

    it('catches throws from a reconciler so peer dispatches are unaffected', async () => {
      const boardHandle = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const tagsHandle = vi.fn();
      registerReconciler({ kind: 'board', handle: boardHandle });
      registerReconciler({ kind: 'config-tags', handle: tagsHandle });

      // First call throws inside; dispatcher swallows it.
      await dispatchExternalChange({
        kind: 'board',
        filename: 'sample.board.json',
        eventType: 'change',
      });
      // Second call still fires its handler.
      await dispatchExternalChange({
        kind: 'config-tags',
        filename: '.filo/tags.json',
        eventType: 'change',
      });

      expect(boardHandle).toHaveBeenCalledTimes(1);
      expect(tagsHandle).toHaveBeenCalledTimes(1);
    });

    it('placeholder reconcilers fire reportError when called without a registration', async () => {
      // Don't register the `board` kind — the placeholder remains active.
      // Its handler calls reportError (which logs and notifies subscribers
      // but does not throw). We assert the dispatch resolves cleanly.
      await expect(
        dispatchExternalChange({
          kind: 'board',
          filename: 'sample.board.json',
          eventType: 'change',
        }),
      ).resolves.toBeUndefined();
    });

    it('last writer wins for repeated registrations of the same kind', async () => {
      const first = vi.fn();
      const second = vi.fn();
      registerReconciler({ kind: 'board', handle: first });
      registerReconciler({ kind: 'board', handle: second });

      await dispatchExternalChange({
        kind: 'board',
        filename: 'x.board.json',
        eventType: 'change',
      });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerBatchedReconciler / dispatchExternalChangeBatch', () => {
    it('groups events by kind and fires batched reconcilers once per kind', async () => {
      const boardHandle = vi.fn();
      const docHandle = vi.fn();
      const batchedBoard: BatchedReconciler = {
        kind: 'board',
        handleBatch: boardHandle,
      };
      const batchedDoc: BatchedReconciler = {
        kind: 'document',
        handleBatch: docHandle,
      };
      registerBatchedReconciler(batchedBoard);
      registerBatchedReconciler(batchedDoc);

      await dispatchExternalChangeBatch([
        { kind: 'board', filename: 'a.board.json', eventType: 'change' },
        { kind: 'document', filename: 'a.md', eventType: 'change' },
        { kind: 'board', filename: 'b.board.json', eventType: 'change' },
        { kind: 'document', filename: 'b.md', eventType: 'change' },
      ]);

      expect(boardHandle).toHaveBeenCalledTimes(1);
      expect(docHandle).toHaveBeenCalledTimes(1);
      const boardBatch = boardHandle.mock.calls[0][0] as ExternalChangeEvent[];
      const docBatch = docHandle.mock.calls[0][0] as ExternalChangeEvent[];
      expect(boardBatch.map((e) => e.filename)).toEqual(['a.board.json', 'b.board.json']);
      expect(docBatch.map((e) => e.filename)).toEqual(['a.md', 'b.md']);
    });

    it('falls back to per-event dispatch when no batched reconciler exists', async () => {
      const singleHandle = vi.fn();
      registerReconciler({ kind: 'board', handle: singleHandle });

      await dispatchExternalChangeBatch([
        { kind: 'board', filename: 'a.board.json', eventType: 'change' },
        { kind: 'board', filename: 'b.board.json', eventType: 'change' },
      ]);

      // Per-event dispatch — fired once per event.
      expect(singleHandle).toHaveBeenCalledTimes(2);
    });

    it('catches throws from a batched reconciler', async () => {
      const boardHandle = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const tagsHandle = vi.fn();
      registerBatchedReconciler({ kind: 'board', handleBatch: boardHandle });
      registerBatchedReconciler({ kind: 'config-tags', handleBatch: tagsHandle });

      await dispatchExternalChangeBatch([
        { kind: 'board', filename: 'x.board.json', eventType: 'change' },
        { kind: 'config-tags', filename: '.filo/tags.json', eventType: 'change' },
      ]);

      expect(boardHandle).toHaveBeenCalledTimes(1);
      expect(tagsHandle).toHaveBeenCalledTimes(1);
    });
  });

  describe('_registeredKindsForTests', () => {
    it('reports only kinds with non-placeholder reconcilers', () => {
      // `tree` and `config` are real (no-op) reconcilers from the start —
      // see the block comment over `reconcilers` in
      // externalChangeRegistry.ts. The other 6 kinds are placeholders
      // until a real reconciler registers.
      expect(_registeredKindsForTests().sort()).toEqual(['config', 'tree']);

      registerReconciler({ kind: 'board', handle: vi.fn() });
      registerReconciler({ kind: 'config-tags', handle: vi.fn() });
      expect(_registeredKindsForTests().sort()).toEqual([
        'board',
        'config',
        'config-tags',
        'tree',
      ]);
    });
  });
});
