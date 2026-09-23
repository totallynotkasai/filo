/**
 * Audit-19 BL-1 — create-exclusive seeding for brand-new `.md` files.
 *
 * Every creation site (new Kanban card, new task, Task-List OS drop, Mind Map
 * text tile) used to write its seed with `vault:write-file-text`, which is
 * create-OR-OVERWRITE. The collision pre-pick only knew about cached tile defs,
 * so a new card titled "Notes" silently replaced an existing off-board
 * `Notes.md`. This module routes every seed through `vault:create-file-text`
 * (an `O_EXCL` open main-side) and bumps to ` (2)`, ` (3)` … on `EEXIST`.
 *
 * Write accounting (the subtle part — pinned by `ci:seed-writes-exclusive`):
 * a LOSING attempt targets the user's EXISTING file, so it must not touch that
 * path's pending / failed / self-write marks. `trackComponentWrite` would
 * (`beginWrite(path)` → `endWrite(true)` erases another writer's failed mark
 * and `markRecentSelfWrite` would hide the file's next external change), so the
 * helper tracks the in-flight window with a PATH-LESS `beginWrite` and only
 * marks the path once the name is ours.
 */
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import {
  beginWrite,
  endWrite,
  markPathFailed,
  markRecentSelfWrite,
  notifyWriteError,
} from '../boards/writeStateTracking';

/** Upper bound on ` (n)` bumps before giving up. */
const MAX_ATTEMPTS = 100;

/** Thrown when every candidate name up to ` (MAX_ATTEMPTS)` already exists. */
export class NameExhaustedError extends Error {
  constructor(base: string) {
    super(`Could not find a free file name for "${base}"`);
    this.name = 'NameExhaustedError';
  }
}

export type ExclusiveCreateOutcome = 'created' | 'exists';

/**
 * Single-attempt primitive: create `relPath` with `content` only if nothing is
 * there. Resolves `'exists'` on EEXIST (no marks touched); `'created'` on
 * success (the path is marked as a recent self-write); throws an
 * `IpcEnvelopeError` for any other failure (toast + sticky failed mark, the same
 * failure surface `trackComponentWrite` gives callers).
 */
export async function createMdFileExclusive(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<ExclusiveCreateOutcome> {
  // Path-less: the in-flight counter + `.filo/.dirty` sentinel cover the create
  // window without claiming a path we may not own.
  beginWrite(vaultRoot);
  let thrown: unknown = null;
  // allow-direct-write: create-exclusive seed of a brand-new .md (EEXIST
  // otherwise), so it can never target an open editor's file.
  const raw = await window.filo.invoke('vault:create-file-text', vaultRoot, relPath, content).catch((err: unknown) => {
    thrown = err;
    return undefined;
  });
  const result = raw as { success?: boolean; code?: string; error?: string } | undefined;
  if (thrown !== null) {
    notifyWriteError({ kind: 'component', path: relPath, error: thrown });
    markPathFailed(vaultRoot, relPath);
    endWrite(vaultRoot, undefined, false);
    throw thrown;
  }
  if (result?.success) {
    markRecentSelfWrite(relPath);
    endWrite(vaultRoot);
    return 'created';
  }
  if (result?.code === 'EEXIST') {
    endWrite(vaultRoot);
    return 'exists';
  }
  const error = new IpcEnvelopeError(
    'vault:create-file-text',
    result?.error ?? 'create failed',
    result?.code,
  );
  notifyWriteError({ kind: 'component', path: relPath, error });
  markPathFailed(vaultRoot, relPath);
  endWrite(vaultRoot, undefined, false);
  throw error;
}

function splitMd(relPath: string): { prefix: string; stem: string } {
  const slash = relPath.lastIndexOf('/');
  const prefix = slash >= 0 ? relPath.slice(0, slash + 1) : '';
  const stem = relPath.slice(prefix.length).replace(/\.md$/i, '');
  return { prefix, stem };
}

/**
 * Creates a brand-new `.md` under `folder`, picking the first free name among
 * `firstCandidate` (or `<baseName>.md`), then `<base> (2).md`, `<base> (3).md` …
 * `buildContent` receives the FINAL title so a template body can interpolate
 * the bumped name.
 */
export async function createUniqueMdFile(args: {
  vaultRoot: string;
  folder: string;
  baseName: string;
  buildContent: (finalTitle: string) => string;
  /** Pre-picked by `nextFreeMdPath`; bumps continue from its own ` (n)`. */
  firstCandidate?: string;
}): Promise<{ relPath: string; finalTitle: string; content: string }> {
  const prefix = args.folder ? `${args.folder}/` : '';
  const first = args.firstCandidate ?? `${prefix}${args.baseName}.md`;
  const { prefix: firstPrefix, stem } = splitMd(first);
  // "Notes (2)" → base "Notes", resume at 3; "Notes" → base "Notes", resume at 2.
  const m = /^(.*) \((\d+)\)$/.exec(stem);
  const base = m?.[1] ?? stem;
  let n = m ? Number(m[2]) + 1 : 2;
  let candidateTitle = stem;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const relPath = `${firstPrefix}${candidateTitle}.md`;
    const content = args.buildContent(candidateTitle);
    const outcome = await createMdFileExclusive(args.vaultRoot, relPath, content);
    if (outcome === 'created') return { relPath, finalTitle: candidateTitle, content };
    candidateTitle = `${base} (${n})`;
    n++;
  }
  throw new NameExhaustedError(base);
}
