import { promises as fs } from 'fs';
import { atomicWriteFile, StaleWriteError } from './filenameUtils';

/** What tells the 0-byte placeholder Filo reserved apart from any other file at that name. */
interface Placeholder {
  ino: number;
  mtimeMs: number;
}

/** The error an exclusive create throws when the name is, or becomes, someone else's file. */
function nameTaken(filePath: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`"${filePath}" already exists; not overwriting it`);
  err.code = 'EEXIST';
  return err;
}

/**
 * Removes the placeholder only while it is still the one Filo made: same file
 * (inode), untouched (mtime) and empty. A sync client or editor that put its
 * own file at the name after the reservation owns that file now, and deleting
 * it would lose their data.
 */
async function removePlaceholderIfUntouched(filePath: string, placeholder: Placeholder): Promise<void> {
  const now = await fs.lstat(filePath).catch(() => null);
  if (!now || !now.isFile() || now.size !== 0) return;
  if (now.ino !== placeholder.ino || now.mtimeMs !== placeholder.mtimeMs) return;
  await fs.unlink(filePath).catch(() => undefined);
}

/**
 * Creates `filePath` with `content`, never over an existing file. The name is
 * reserved with an `O_EXCL` open (`'wx'`, case-insensitive on NTFS/APFS), then
 * the bytes land atomically over that 0-byte placeholder. The write names the
 * placeholder's stat, so a file another program put at the name meanwhile is
 * never overwritten. Either clash throws code `EEXIST`, so the caller can pick
 * another name or keep the other copy. A failed write leaves the name free
 * again, unless it now holds someone else's file.
 *
 * The placeholder is stat'd through its own handle, so the stamp is of the
 * file Filo created even if another program swaps the name right after.
 */
export async function createExclusiveFile(filePath: string, content: string): Promise<void> {
  let placeholder: Placeholder;
  const handle = await fs.open(filePath, 'wx');
  try {
    const st = await handle.stat();
    placeholder = { ino: st.ino, mtimeMs: st.mtimeMs };
  } finally {
    await handle.close();
  }
  try {
    await atomicWriteFile(filePath, content, { expectStat: { mtimeMs: placeholder.mtimeMs, size: 0 } });
  } catch (err) {
    await removePlaceholderIfUntouched(filePath, placeholder);
    if (err instanceof StaleWriteError) throw nameTaken(filePath);
    throw err;
  }
}
