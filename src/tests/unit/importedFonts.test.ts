import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireVaultSwap } from '../../renderer/core/vaultLifecycle';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import {
  dropImportedFonts,
  loadVaultFonts,
  registerImportedFonts,
} from '../../renderer/lib/fonts/importedFonts';

/**
 * Imported fonts are registered again on every vault open (a `FontFace`
 * doesn't outlive the page, so they vanished after a restart), and a vault
 * swap drops them. jsdom has no font API, so `FontFace` and `document.fonts`
 * are small fakes that record what was added.
 */

class FakeFontFace {
  readonly family: string;
  readonly bytes: ArrayBuffer;
  constructor(family: string, bytes: ArrayBuffer) {
    this.family = family;
    this.bytes = bytes;
  }
  async load(): Promise<this> {
    if (this.family === 'Broken') throw new Error('not a font');
    return this;
  }
}

const added = new Set<FakeFontFace>();
const invoke = vi.fn();

function font(name: string): { name: string; path: string; dataBase64: string } {
  return { name, path: `C:/vault/.filo/fonts/${name}.ttf`, dataBase64: btoa(`bytes of ${name}`) };
}

function families(): string[] {
  return [...added].map((face) => face.family).sort();
}

beforeEach(() => {
  added.clear();
  invoke.mockReset();
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (face: FakeFontFace) => added.add(face),
      delete: (face: FakeFontFace) => added.delete(face),
    },
  });
  (window as unknown as Record<string, unknown>).filo = { invoke };
  __resetVaultIdentityForTests();
  beginVaultGeneration('C:/vault');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  dropImportedFonts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('importedFonts', () => {
  it('registers every font of the vault on open, from the bytes main reads', async () => {
    invoke.mockResolvedValue({ success: true, fonts: [font('Alpha'), font('Beta')] });

    await loadVaultFonts('C:/vault');

    expect(invoke).toHaveBeenCalledWith('font:list-imported', 'C:/vault');
    expect(families()).toEqual(['Alpha', 'Beta']);
    const alpha = [...added].find((face) => face.family === 'Alpha');
    expect(new TextDecoder().decode(alpha?.bytes)).toBe('bytes of Alpha');
  });

  it('drops them on a vault swap, so the next vault never renders in them', async () => {
    invoke.mockResolvedValue({ success: true, fonts: [font('Alpha')] });
    await loadVaultFonts('C:/vault');
    expect(families()).toEqual(['Alpha']);

    await fireVaultSwap({ phase: 'pre-swap', previousVault: 'C:/vault', nextVault: 'C:/other', saveOutgoing: true });

    expect(families()).toEqual([]);
  });

  it('does not register a vault that closed while its fonts were being read', async () => {
    let answer: (value: unknown) => void = () => undefined;
    invoke.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const loading = loadVaultFonts('C:/vault');
    beginVaultGeneration('C:/other');
    answer({ success: true, fonts: [font('Alpha')] });
    await loading;

    expect(families()).toEqual([]);
  });

  it('skips a font that fails to load and keeps the rest', async () => {
    const loaded = await registerImportedFonts([font('Broken'), font('Good')]);

    expect(loaded.map((f) => f.name)).toEqual(['Good']);
    expect(families()).toEqual(['Good']);
  });

  it('registers nothing when main refuses the vault', async () => {
    invoke.mockResolvedValue({ success: false, fonts: [], error: 'Vault path mismatch' });

    await loadVaultFonts('C:/vault');

    expect(families()).toEqual([]);
  });
});
