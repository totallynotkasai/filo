import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import type { Connection } from '../schema/index';
import { applyKeyDelta, isEmptyKeyDelta, keyDelta, type KeyDelta } from './keyDelta';

type Fields = Record<string, unknown>;

/** A connection step as the fields it changed, and the label keys it changed. */
interface ConnectionDelta {
  fields: KeyDelta;
  label: KeyDelta | null;
}

function connectionDelta(from: Partial<Connection>, to: Partial<Connection>): ConnectionDelta {
  const { label: fromLabel, ...fromFields } = from;
  const { label: toLabel, ...toFields } = to;
  const labelled = 'label' in from || 'label' in to;
  return {
    fields: keyDelta(fromFields as Fields, toFields as Fields),
    label: labelled ? keyDelta(fromLabel as Fields | undefined, toLabel as Fields | undefined) : null,
  };
}

export class AddConnectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private connection: Connection;

  constructor(connection: Connection, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // Deep-clone so the snapshot doesn't share its nested `label` object with
    // the live store.
    this.connection = this.snapshot(connection);
    this.description = `Add connection`;
  }

  execute() {
    boardStore.addConnection(this.snapshot(this.connection));
  }

  undo() {
    boardStore.removeConnection(this.connection.id);
  }
}

export class DeleteConnectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private connection: Connection;

  constructor(connectionId: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    const conn = boardStore.connections[connectionId];
    // Explicit not-found guard: otherwise `this.snapshot(undefined)` throws an
    // opaque JSON.parse error for what is really a stale UI handle racing a
    // connection that was already removed.
    if (!conn) throw new Error(`DeleteConnectionCommand: connection ${connectionId} not found`);
    // Deep-clone so a label-text edit between delete and undo can't mutate
    // the snapshot's nested `label` through the live store.
    this.connection = this.snapshot(conn);
    this.description = `Delete connection`;
  }

  execute() {
    boardStore.removeConnection(this.connection.id);
  }

  undo() {
    // Clone again on restore so a future delete-and-undo cycle on the same
    // command instance doesn't share references with the post-undo store.
    boardStore.addConnection(this.snapshot(this.connection));
  }
}

/**
 * A connection's style or label change. It keeps the fields it changed, and
 * the label keys it changed, so undo and redo change only those on the
 * connection as it stands: a label size "Use Default Font Sizes" cleared
 * since stays cleared (`keyDelta.ts`).
 */
export class UpdateConnectionCommand extends Command {
  description: string;
  /**
   * ConnectionStylePopup captures this at popup mount and threads it
   * through; the popup's destroy effect can fire after a board switch.
   */
  readonly targetBoardId: string;
  private connId: string;
  private forward: ConnectionDelta;
  private inverse: ConnectionDelta;

  constructor(
    connId: string,
    beforeUpdates: Partial<Connection>,
    afterUpdates: Partial<Connection>,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.connId = connId;
    // Deep-cloned first, so a later mutation of the nested `label` object on
    // either patch can't leak into the deltas used by undo.
    const before = this.snapshot(beforeUpdates);
    const after = this.snapshot(afterUpdates);
    this.forward = connectionDelta(before, after);
    this.inverse = connectionDelta(after, before);
    this.description = `Update connection`;
  }

  private apply(delta: ConnectionDelta): void {
    const existing = boardStore.connections[this.connId];
    if (!existing) return;
    const patch: Fields = applyKeyDelta({}, delta.fields);
    for (const key of delta.fields.unset) patch[key] = undefined;
    if (delta.label && !isEmptyKeyDelta(delta.label)) patch.label = applyKeyDelta(existing.label as Fields | undefined, delta.label);
    boardStore.updateConnection(this.connId, patch as Partial<Connection>);
  }

  execute() {
    this.apply(this.forward);
  }

  undo() {
    this.apply(this.inverse);
  }
}
