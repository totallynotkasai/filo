/**
 * A hand-written test command as a real `Command`. The `Command` type is the
 * abstract class merged with its interface, so it carries `snapshot`
 * (protected) and `renamePath`, which a plain object literal can't supply.
 * `fakeCommand` copies the literal's members onto an instance of an inert
 * subclass, so `this` inside its methods is the returned command and any
 * counters it declares live on that object. A literal without a
 * `targetBoardId` gets `''` (board-agnostic, which the history store treats
 * the same as a missing one).
 */
import { Command } from '../../renderer/commands/Command';

export interface FakeCommandSpec {
  description: string;
  targetBoardId?: string;
  execute(): void | Promise<void>;
  undo(): void | Promise<void>;
}

class InertCommand extends Command {
  description = '';
  readonly targetBoardId: string = '';
  execute(): void {}
  undo(): void {}
}

export function fakeCommand<T extends FakeCommandSpec>(spec: T): Command & T {
  return Object.assign(new InertCommand(), spec);
}
