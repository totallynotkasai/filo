/**
 * A command's body found that its note can't take the change (frontmatter
 * Filo can't edit safely, a read-only note, an edit still waiting to be
 * saved), so nothing changed. The history store shows the message and takes
 * the step off the stack (execute) or leaves it where it was (undo / redo),
 * so no step that did nothing sits on the undo stack.
 */
export class ChangeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeRefusedError';
  }
}
