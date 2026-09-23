/**
 * Audit-19 EXT-6 / ERR-8 (plan D5) — per-machine crash-recovery sentinels.
 *
 * The sentinels live in the vault's `.filo/`, which a cloud client syncs to
 * every machine. With ONE shared name per kind, machine B's clean shutdown
 * deleted machine A's crash breadcrumb, B prompted for A's unflushed files (the
 * data only exists on A), and B could "resume" A's half-finished tag rename.
 * Each machine now owns `<name>.<machineId>` (machine id minted in userData,
 * 12 lowercase hex) and only ever writes / deletes its own.
 *
 * THE single home of the legacy (pre-Audit-19) bare names: they are read and
 * consumed once for migration, never written. `ci:sentinel-machine-scoped`
 * forbids those literals anywhere else in src/main and src/renderer.
 */

export type SentinelKind = 'dirty' | 'rename-cascade' | 'tag-rewrite' | 'quit-failure';

export const SENTINEL_KINDS: readonly SentinelKind[] = ['dirty', 'rename-cascade', 'tag-rewrite', 'quit-failure'];

/** Legacy shared sentinel paths — read + deleted once for migration, never written. */
export const LEGACY_SENTINEL_PATHS: Readonly<Record<SentinelKind, string>> = {
  dirty: '.filo/.dirty',
  'rename-cascade': '.filo/rename-cascade-pending.json',
  'tag-rewrite': '.filo/tag-rewrite-pending.json',
  'quit-failure': '.filo/quit-failure.json',
};

/** A machine id: 12 lowercase hex characters. */
export const MACHINE_ID_RE = /^[0-9a-f]{12}$/;

/** `.filo/`-relative basename for `kind` owned by `machineId`. */
export function machineSentinelBasename(kind: SentinelKind, machineId: string): string {
  switch (kind) {
    case 'dirty': return `.dirty.${machineId}`;
    case 'rename-cascade': return `rename-cascade-pending.${machineId}.json`;
    case 'tag-rewrite': return `tag-rewrite-pending.${machineId}.json`;
    case 'quit-failure': return `quit-failure.${machineId}.json`;
  }
}

/** Vault-relative path of `kind`'s sentinel owned by `machineId`. */
export function machineSentinelPath(kind: SentinelKind, machineId: string): string {
  return `.filo/${machineSentinelBasename(kind, machineId)}`;
}

const PATTERNS: ReadonlyArray<[SentinelKind, RegExp]> = [
  ['dirty', /^\.dirty(?:\.([0-9a-f]{12}))?$/],
  ['rename-cascade', /^rename-cascade-pending(?:\.([0-9a-f]{12}))?\.json$/],
  ['tag-rewrite', /^tag-rewrite-pending(?:\.([0-9a-f]{12}))?\.json$/],
  ['quit-failure', /^quit-failure(?:\.([0-9a-f]{12}))?\.json$/],
];

/**
 * Parses a sentinel BASENAME (the file inside `.filo/`). `machineId` is null
 * for a legacy bare name. Returns null for anything that isn't a sentinel.
 */
export function parseSentinelBasename(name: string): { kind: SentinelKind; machineId: string | null } | null {
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(name);
    if (m) return { kind, machineId: m[1] ?? null };
  }
  return null;
}

/** Parses a vault-relative path (`.filo/<sentinel>`); null when it isn't one. */
export function parseSentinelPath(relPath: string): { kind: SentinelKind; machineId: string | null } | null {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== '.filo') return null;
  return parseSentinelBasename(parts[1]!);
}
