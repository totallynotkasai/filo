import type { MoveIntoFolderResult } from '../../stores/vaultFolderOps';

/**
 * Phase 1 / 1.4 — translates a single `moveIntoFolder` failure into a
 * concrete toast message. Centralised so VaultSidebar and VaultFileItem
 * surface the same wording for the same failure mode, and so the test
 * suite can pin the copy without rendering the full sidebar component.
 */
export function describeMoveIntoFolderFailure(
  result: Extract<MoveIntoFolderResult, { ok: false }>,
  sourceName: string,
  targetName: string,
): string {
  switch (result.code) {
    case 'TARGET_EXISTS':
      return `A file named "${sourceName}" already exists in "${targetName}".`;
    case 'PERMISSION_DENIED':
      return `Permission denied moving "${sourceName}" into "${targetName}".`;
    case 'OTHER':
    default: {
      const detail = result.reason ? ` (${result.reason})` : '';
      return `Couldn't move "${sourceName}" into "${targetName}"${detail}.`;
    }
  }
}

/**
 * Returns the final segment of a path. Mirrors the `path.basename`
 * semantics needed by the toast helper without pulling Node `path` into
 * the renderer.
 */
export function basenameOf(path: string): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i];
  }
  return path;
}
