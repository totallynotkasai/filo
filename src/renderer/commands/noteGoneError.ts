/**
 * An undo or redo whose note is no longer on disk. The change is not queued
 * (a write to a missing file can't land, and would block later disk
 * operations on that path), and the history store keeps the command where it
 * was and tells the user.
 */
export class NoteGoneError extends Error {
  readonly relPath: string;

  constructor(relPath: string) {
    super(`"${relPath}" no longer exists.`);
    this.name = 'NoteGoneError';
    this.relPath = relPath;
  }
}
