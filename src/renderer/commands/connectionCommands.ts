import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import type { Connection } from '../schema/index';

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

export class UpdateConnectionCommand extends Command {
  description: string;
  /**
   * ConnectionStylePopup captures this at popup mount and threads it
   * through; the popup's destroy effect can fire after a board switch.
   */
  readonly targetBoardId: string;
  private connId: string;
  private beforeUpdates: Partial<Connection>;
  private afterUpdates: Partial<Connection>;

  constructor(
    connId: string,
    beforeUpdates: Partial<Connection>,
    afterUpdates: Partial<Connection>,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.connId = connId;
    // Deep-clone so a later mutation of the nested `label`
    // object on either patch can't leak into the snapshot used by undo.
    this.beforeUpdates = this.snapshot(beforeUpdates);
    this.afterUpdates = this.snapshot(afterUpdates);
    this.description = `Update connection`;
  }

  execute() {
    boardStore.updateConnection(this.connId, this.afterUpdates);
  }

  undo() {
    boardStore.updateConnection(this.connId, this.beforeUpdates);
  }
}
