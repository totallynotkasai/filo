/**
 * Per-machine crash-recovery sentinels.
 *
 * The sentinels live in the vault's `.filo/`, which a cloud client syncs to
 * every machine. With ONE shared name per kind, machine B's clean shutdown
 * would delete machine A's crash breadcrumb, B would prompt for A's unflushed
 * files (the data only exists on A), and B could "resume" A's half-finished
 * tag rename. So each machine owns `<name>.<machineId>` (machine id minted in
 * userData, 12 lowercase hex) and only ever writes / deletes its own. A bare
 * shared name (`.filo/.dirty`) is not a sentinel: nothing reads or writes it,
 * and `gates:sentinel-machine-scoped` forbids those literals in src/main and
 * src/renderer.
 */

export type SentinelKind = 'dirty' | 'rename-cascade' | 'tag-rewrite' | 'quit-failure';

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
  ['dirty', /^\.dirty\.([0-9a-f]{12})$/],
  ['rename-cascade', /^rename-cascade-pending\.([0-9a-f]{12})\.json$/],
  ['tag-rewrite', /^tag-rewrite-pending\.([0-9a-f]{12})\.json$/],
  ['quit-failure', /^quit-failure\.([0-9a-f]{12})\.json$/],
];

/**
 * Parses a sentinel BASENAME (the file inside `.filo/`). Returns null for
 * anything that isn't a per-machine sentinel.
 */
export function parseSentinelBasename(name: string): { kind: SentinelKind; machineId: string } | null {
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(name);
    if (m?.[1]) return { kind, machineId: m[1] };
  }
  return null;
}

/** Parses a vault-relative path (`.filo/<sentinel>`); null when it isn't one. */
export function parseSentinelPath(relPath: string): { kind: SentinelKind; machineId: string } | null {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== '.filo') return null;
  return parseSentinelBasename(parts[1]!);
}
