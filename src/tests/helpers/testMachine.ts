/**
 * Audit-19 EXT-6 — the fixed machine identity the unit-test setup pins, plus
 * the per-machine sentinel paths built from it.
 */
import { machineSentinelPath, type SentinelKind } from '../../shared/sentinelPaths';

export const TEST_MACHINE_IDENTITY = { machineId: 'a1b2c3d4e5f6', hostname: 'TEST-HOST' };

/** Vault-relative path of the test machine's `kind` sentinel. */
export function testSentinelPath(kind: SentinelKind): string {
  return machineSentinelPath(kind, TEST_MACHINE_IDENTITY.machineId);
}
