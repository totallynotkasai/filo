/**
 * The ONE sync-client conflict-copy detector, shared by main
 * (board scan, rename correlation, sync-conflict notices) and the renderer
 * (duplicate-board tie-break). Pure, dependency-free: `src/shared` is bundled
 * into both processes, so this file must never import Node or DOM modules.
 *
 * Documented naming schemes (every client inserts its suffix before the LAST
 * extension):
 *   - OneDrive:  `Note-<DEVICE NAME>.md`            (strong only for a KNOWN host
 *                                                    or a Windows default hostname)
 *   - Dropbox:   `Note (Andrew's conflicted copy 2026-09-23).md`, `(Case Conflict)`,
 *                `(Selective Sync Conflict)`          (strong)
 *   - Nextcloud: `Note (conflicted copy 2026-09-23 101112).md` (strong, Dropbox shape)
 *   - Syncthing: `Note.sync-conflict-20260923-101112-ABCDEFG.md` (strong)
 *   - Google Drive: `Note (1).md`                    (weak)
 *   - iCloud:    `Note 2.md`                          (weak)
 *
 * False-positive policy (DECISION): a WEAK match counts only when the
 * caller's `exists` probe confirms the canonical sibling is present — never on
 * the name alone (`Report (2).md` with no `Report.md` is an ordinary file).
 * Consumers treat a match only as a tie-break preference / correlation
 * refusal / notice, never as grounds to delete, hide or rename anything.
 *
 * Board carve-out: `Plan (1).board.json` (a tool that treats `.board.json` as
 * the extension) canonicalises to `Plan.board.json`, as does the sync-client
 * shape `Plan.board-HOST.json`.
 */

export type ConflictStrength = 'strong' | 'weak';
export type ConflictClient = 'onedrive' | 'dropbox' | 'gdrive' | 'icloud' | 'syncthing';

export interface ConflictMatch {
  strength: ConflictStrength;
  client: ConflictClient;
  /** Canonical basename (or rel path, for `canonicalPathFor`). */
  canonicalName: string;
}

export interface ConflictCopyOptions {
  /** OneDrive device names seen for this vault (this machine + `.filo/machines/*`). */
  knownHosts?: readonly string[];
  /**
   * Probe for the canonical sibling. Receives the canonical name in the SAME
   * form as the input (basename for `detectConflictCopy`, rel path for
   * `canonicalPathFor`). Required for a weak match to count.
   */
  exists?: (canonical: string) => boolean;
}

interface SuffixRule {
  re: RegExp;
  client: ConflictClient;
  strength: ConflictStrength;
}

const STATIC_RULES: readonly SuffixRule[] = [
  {
    re: / \((?:[^()]*['’]s )?conflicted copy(?: \d{4}-\d{2}-\d{2})?(?: \d{6})?\)$/i,
    client: 'dropbox',
    strength: 'strong',
  },
  { re: / \((?:Case|Selective Sync) Conflict\)$/i, client: 'dropbox', strength: 'strong' },
  { re: /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}$/, client: 'syncthing', strength: 'strong' },
  // Windows default hostname — uppercase, case-SENSITIVE; nobody types this.
  { re: /-(?:DESKTOP|LAPTOP)-[A-Z0-9]{7}(?:-\d+)?$/, client: 'onedrive', strength: 'strong' },
];

const WEAK_RULES: readonly SuffixRule[] = [
  { re: / \(\d{1,3}\)$/, client: 'gdrive', strength: 'weak' },
  { re: / \d{1,3}$/, client: 'icloud', strength: 'weak' },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostRules(knownHosts: readonly string[] | undefined): SuffixRule[] {
  if (!knownHosts) return [];
  const rules: SuffixRule[] = [];
  for (const host of knownHosts) {
    const h = host.trim();
    if (!h) continue;
    rules.push({
      re: new RegExp(`-${escapeRegex(h)}(?:-\\d+)?$`, 'i'),
      client: 'onedrive',
      strength: 'strong',
    });
  }
  return rules;
}

/** Splits `name` into [stem, ext] on the LAST dot (a leading dot is not an extension). */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

function matchStem(
  stem: string,
  ext: string,
  opts: ConflictCopyOptions | undefined,
): ConflictMatch | null {
  const strongRules = [...STATIC_RULES, ...hostRules(opts?.knownHosts)];
  for (const rule of strongRules) {
    const m = rule.re.exec(stem);
    if (!m) continue;
    const base = stem.slice(0, m.index);
    // A bare suffix as the whole name (`DESKTOP-1A2B3C4.md`) has no original.
    if (!base.trim()) continue;
    return { strength: rule.strength, client: rule.client, canonicalName: base + ext };
  }
  for (const rule of WEAK_RULES) {
    const m = rule.re.exec(stem);
    if (!m) continue;
    const base = stem.slice(0, m.index);
    if (!base.trim()) continue;
    const canonicalName = base + ext;
    if (!opts?.exists || !opts.exists(canonicalName)) return null;
    return { strength: rule.strength, client: rule.client, canonicalName };
  }
  return null;
}

/**
 * Basename in → conflict match (with the canonical basename) or null.
 */
export function detectConflictCopy(
  basename: string,
  opts?: ConflictCopyOptions,
): ConflictMatch | null {
  if (!basename) return null;
  const [stem, ext] = splitExt(basename);
  if (!ext) return null;
  // Board carve-out: `Plan (1).board.json` — the suffix sits before the
  // compound `.board.json`. Try that split first so the canonical keeps it.
  if (ext.toLowerCase() === '.json' && /\.board$/i.test(stem)) {
    const inner = stem.slice(0, -'.board'.length);
    const compoundExt = stem.slice(-'.board'.length) + ext;
    if (inner) {
      const hit = matchStem(inner, compoundExt, opts);
      if (hit) return hit;
    }
  }
  return matchStem(stem, ext, opts);
}

function splitDir(relPath: string): [string, string] {
  const i = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  if (i < 0) return ['', relPath];
  return [relPath.slice(0, i + 1), relPath.slice(i + 1)];
}

/**
 * Full rel path in → rel path of the canonical original (dir preserved), or
 * null when the name is not a (confirmed) conflict copy.
 */
export function canonicalPathFor(relPath: string, opts?: ConflictCopyOptions): string | null {
  return detectConflictCopyPath(relPath, opts)?.canonicalName ?? null;
}

/** Full-path variant returning the whole match (canonicalName is a rel path). */
export function detectConflictCopyPath(
  relPath: string,
  opts?: ConflictCopyOptions,
): ConflictMatch | null {
  const [dir, name] = splitDir(relPath);
  const probe = opts?.exists;
  const hit = detectConflictCopy(name, {
    knownHosts: opts?.knownHosts,
    exists: probe ? (canonicalName: string): boolean => probe(dir + canonicalName) : undefined,
  });
  return hit ? { ...hit, canonicalName: dir + hit.canonicalName } : null;
}
