/**
 * The atomic-write temp name `<base>.<12 hex>.tmp` adds 17 characters, so a
 * legal 239–255-character note name made the TEMP component exceed the
 * 255 limit and every save failed with ENAMETOOLONG.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readdirSync, readFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile, tmpSiblingPath } from '../../main/vault/filenameUtils';

const NONCE = 'a1b2c3d4e5f6';

describe('tmpSiblingPath', () => {
  it('leaves short names unchanged', () => {
    expect(tmpSiblingPath('C:/vault/Notes/Plan.md', NONCE)).toBe(`C:/vault/Notes/Plan.md.${NONCE}.tmp`);
    expect(tmpSiblingPath('C:\\vault\\Plan.md', NONCE)).toBe(`C:\\vault\\Plan.md.${NONCE}.tmp`);
    expect(tmpSiblingPath('Plan.md', NONCE)).toBe(`Plan.md.${NONCE}.tmp`);
  });

  it('keeps the tmp component of a 255-character name at ≤ 255', () => {
    const name = `${'n'.repeat(252)}.md`;
    const tmp = tmpSiblingPath(`/vault/${name}`, NONCE);
    const component = basename(tmp);
    expect(component.length).toBeLessThanOrEqual(255);
    expect(component.endsWith(`.${NONCE}.tmp`)).toBe(true);
    expect(tmp.startsWith('/vault/')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const name = '😀'.repeat(125) + '.md'; // 253 UTF-16 units
    const component = basename(tmpSiblingPath(`/vault/${name}`, NONCE));
    expect(component.length).toBeLessThanOrEqual(255);
    // No lone surrogate: every high surrogate is followed by a low one.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(component)).toBe(false);
  });

  it('also fits the 255-byte limit of ext4/APFS for multi-byte names', () => {
    const name = 'é'.repeat(120) + '.md'; // 243 bytes in UTF-8
    const component = basename(tmpSiblingPath(`/vault/${name}`, NONCE));
    expect(Buffer.byteLength(component, 'utf8')).toBeLessThanOrEqual(255);
  });
});

describe('atomicWriteFile — a 250-character name saves', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-longname-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file and leaves no tmp behind', async () => {
    const name = `${'L'.repeat(247)}.md`;
    expect(name.length).toBe(250);
    await atomicWriteFile(join(dir, name), '# Long\n');
    expect(await fs.readFile(join(dir, name), 'utf-8')).toBe('# Long\n');
    expect(readdirSync(dir)).toEqual([name]);
  });
});

describe('every main-side tmp name goes through tmpSiblingPath', () => {
  it('no `${…}.${nonce}.tmp` template outside the helper', () => {
    const root = resolve(__dirname, '..', '..', 'main');
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          // machineIdentity.ts writes a fixed short name in userData and can't
          // import filenameUtils (pathSecurity → machineIdentity cycle).
          if (p.endsWith('machineIdentity.ts')) continue;
          const src = readFileSync(p, 'utf-8');
          if (/`\$\{[^}]+\}\.\$\{[^}]+\}\.tmp`/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
