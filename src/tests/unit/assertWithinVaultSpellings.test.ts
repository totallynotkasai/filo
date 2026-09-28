import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertWithinVault } from '../../main/utils/pathSecurity';

// Main registers the vault root canonical (realpath), while a path the
// renderer builds keeps the spelling the vault was opened with: an 8.3 short
// name (`C:\Users\RUNNER~1\...`) or a junction. The same folder spelled two
// ways must still count as inside the vault, and a real escape must not.
describe('assertWithinVault: one folder, two spellings', () => {
  let base: string;
  let realVault: string;
  let viaLink: string;
  let outside: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'filo-spell-')));
    fs.mkdirSync(path.join(base, 'real', 'Vault', '.filo', 'recovery'), { recursive: true });
    fs.mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
    fs.writeFileSync(path.join(base, 'real', 'Vault', '.filo', 'recovery', 'Broken.board.json'), '{');
    // A junction needs no admin rights on Windows; elsewhere it is a dir symlink.
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'junction');
    realVault = path.join(base, 'real', 'Vault');
    viaLink = path.join(base, 'link', 'Vault');
    outside = path.join(base, 'elsewhere');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('accepts an existing file named through the other spelling of the root', () => {
    expect(() => assertWithinVault(realVault, path.join(viaLink, '.filo', 'recovery', 'Broken.board.json'))).not.toThrow();
  });

  it('accepts a file not created yet under the other spelling', () => {
    expect(() => assertWithinVault(realVault, path.join(viaLink, 'New', 'Note.md'))).not.toThrow();
  });

  it('works the other way round (root in the opened spelling, target canonical)', () => {
    expect(() => assertWithinVault(viaLink, path.join(realVault, 'Note.md'))).not.toThrow();
  });

  it('still refuses a path outside the vault, whatever its spelling', () => {
    expect(() => assertWithinVault(realVault, path.join(outside, 'x.md'))).toThrow(/outside vault/);
    expect(() => assertWithinVault(viaLink, path.join(base, 'link', 'x.md'))).toThrow(/outside vault/);
    expect(() => assertWithinVault(realVault, path.join(viaLink, '..', '..', 'elsewhere', 'x.md'))).toThrow(/outside vault/);
  });
});
