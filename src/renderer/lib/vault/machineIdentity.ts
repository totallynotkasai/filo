/**
 * Audit-19 EXT-6 (plan D5) — this machine's identity, cached for the renderer.
 *
 * Fetched ONCE at app boot (`loadMachineIdentity`, awaited before any vault
 * opens) from main's `app:machine-identity` (userData/machine-id.json). Every
 * crash-recovery sentinel the renderer names is built from it, so a machine
 * only ever writes / clears / prompts for its OWN sentinels in a synced
 * `.filo/` (main enforces the write side too).
 *
 * The unit-test setup pins a fixed id via `__setMachineIdentityForTests`.
 */
import { machineSentinelPath, type SentinelKind } from '@shared/sentinelPaths';

export interface MachineIdentity {
  machineId: string;
  hostname: string;
}

let identity: MachineIdentity | null = null;

export async function loadMachineIdentity(): Promise<MachineIdentity> {
  if (identity) return identity;
  const res = await window.filo.invoke('app:machine-identity');
  identity = { machineId: res.machineId, hostname: res.hostname };
  return identity;
}

/**
 * This machine's identity. Throws when called before `loadMachineIdentity`
 * resolved — naming a sentinel without it could touch another machine's file.
 */
export function getMachineIdentity(): MachineIdentity {
  if (!identity) {
    throw new Error('machine identity not loaded yet (loadMachineIdentity must run before a vault opens)');
  }
  return identity;
}

/** Vault-relative path of THIS machine's `kind` sentinel. */
export function ownSentinelPath(kind: SentinelKind): string {
  return machineSentinelPath(kind, getMachineIdentity().machineId);
}

/** Test-only. */
export function __setMachineIdentityForTests(next: MachineIdentity | null): void {
  identity = next;
}
