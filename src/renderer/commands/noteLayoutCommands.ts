import { NoteFieldCommand } from './noteFieldCommand';

/**
 * Sets a note's line spacing (frontmatter `lineSpacing:`), or removes the key
 * with `null` so every view falls back to its own default. The whole note
 * shares one spacing, shown the same in every view of it. See
 * `NoteFieldCommand` for the execute / undo / redo rules.
 */
export class SetLineSpacingCommand extends NoteFieldCommand {
  constructor(boardId: string, relPath: string, value: number | null, before: number | null) {
    // An empty value clears the key (see `patchToFrontmatterDelta`).
    super(boardId, relPath, { lineSpacing: value ?? '' }, { lineSpacing: before ?? '' }, 'Change line spacing');
  }
}
