import type { Connection } from '../schema/index';
import { ConnectionSchema } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import type { BoardContext } from './boardStoreTypes';

/**
 * Board slice — connection CRUD for the active board.
 *
 * Phase R7 (Reactive BoardScope, 2026-05-26) — the per-pane `connections`
 * view is `$derived` from `boardCacheStore.cache[currentBoardId].connections`.
 * Every mutator forwards to `boardCacheStore.persist*Connection`; the active
 * derivation re-fires automatically when the cache settles. No per-pane
 * runtime state to keep in sync.
 */
export function makeConnectionsSlice(ctx: BoardContext) {
  return {
    addConnection(conn: Connection): void {
      const parsed = ConnectionSchema.safeParse(conn);
      if (!parsed.success) {
        console.warn('[boardStore] addConnection validation failed:', parsed.error.issues);
      }
      const valid = parsed.success ? (parsed.data as Connection) : conn;
      boardCacheStore.persistAddConnection(valid);
    },

    persistAddConnection(conn: Connection): void {
      boardCacheStore.persistAddConnection(conn);
    },

    connectionExistsBetween(
      fromTileId: string,
      fromBubble: number,
      toTileId: string,
      toBubble: number,
    ): boolean {
      return Object.values(ctx.getConnections()).some(
        (c) =>
          (c.fromTileId === fromTileId
            && c.fromBubble === fromBubble
            && c.toTileId === toTileId
            && c.toBubble === toBubble)
          || (c.fromTileId === toTileId
            && c.fromBubble === toBubble
            && c.toTileId === fromTileId
            && c.toBubble === fromBubble),
      );
    },

    removeConnection(connId: string): void {
      const existing = ctx.getConnections()[connId];
      if (existing) boardCacheStore.persistRemoveConnection(connId, existing);
    },

    persistRemoveConnection(connId: string, conn: Connection): void {
      boardCacheStore.persistRemoveConnection(connId, conn);
    },

    updateConnection(connId: string, updates: Partial<Connection>): void {
      const existing = ctx.getConnections()[connId];
      if (!existing) return;
      const merged = { ...existing, ...updates, updatedAt: Date.now() } as Connection;
      const parsed = ConnectionSchema.safeParse(merged);
      if (!parsed.success) {
        console.warn('[boardStore] updateConnection validation failed:', parsed.error.issues);
      }
      const valid = parsed.success ? (parsed.data as Connection) : merged;
      boardCacheStore.persistUpdateConnection(connId, valid);
    },

    persistUpdateConnection(connId: string, updated: Connection): void {
      boardCacheStore.persistUpdateConnection(connId, updated);
    },
  };
}
