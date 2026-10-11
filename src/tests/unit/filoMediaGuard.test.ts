/**
 * The filo:// media protocol must apply the same `.filo/`
 * carve-out and structural validation that every other renderer-facing vault
 * read enforces, not just `assertWithinVault`. The decision logic lives in the
 * pure `resolveServableMediaPath` (mirroring how rangeHeader.ts factors the
 * Range decision out of the protocol glue); this tests it directly.
 *
 * Regression context: the handler ran only `assertWithinVault`, so path
 * traversal was blocked but `filo://media/.filo/tags.json` (or a hand-edited
 * tile `file` pointing into `.filo/`) streamed config bytes — a divergence
 * from the project's own stated threat model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { resolveServableMediaPath } from '../../main/protocol/mediaPathGuard';
import { FiloDirForbiddenError } from '../../main/utils/pathSecurity';

describe('resolveServableMediaPath enforces the .filo/ guard', () => {
  let vaultRoot = '';

  beforeAll(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-media-guard-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it('rejects a path into .filo/ with the FORBIDDEN error', () => {
    expect(() => resolveServableMediaPath(vaultRoot, '.filo/tags.json')).toThrow(
      FiloDirForbiddenError,
    );
  });

  it('rejects a path-traversal escape', () => {
    expect(() => resolveServableMediaPath(vaultRoot, '../outside.png')).toThrow();
  });

  it('resolves a normal vault-relative media path to an absolute path inside the vault', () => {
    const abs = resolveServableMediaPath(vaultRoot, 'attachments/pic.png');
    expect(abs).toBe(path.join(vaultRoot, 'attachments/pic.png'));
  });
});
