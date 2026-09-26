import { onVaultSwap } from '../../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';
import { reportError } from '../utils/errorBus';

/**
 * Fonts imported into a vault (`.filo/fonts/`), registered with the page.
 *
 * A `FontFace` lasts only as long as the page, so every vault open registers
 * the vault's fonts again, and a vault swap drops them: another vault naming
 * the same family must not render in this vault's file.
 */

export interface ImportedFontData {
  name: string;
  dataBase64: string;
}

/** The faces this vault added, so a swap removes exactly those. */
let registered: FontFace[] = [];

function base64Bytes(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Registers each font under its name. Returns the ones that loaded; a font
 * the browser can't parse is reported and skipped, so one bad file doesn't
 * keep the others out.
 */
export async function registerImportedFonts(
  fonts: readonly ImportedFontData[],
): Promise<{ name: string; face: FontFace }[]> {
  const loaded: { name: string; face: FontFace }[] = [];
  for (const font of fonts) {
    try {
      const face = new FontFace(font.name, base64Bytes(font.dataBase64));
      await face.load();
      document.fonts.add(face);
      registered.push(face);
      loaded.push({ name: font.name, face });
    } catch (err) {
      reportError('importedFonts.register', err, `Couldn't load the font "${font.name}".`);
    }
  }
  return loaded;
}

/** Registers every font in the open vault's `.filo/fonts/`. */
export async function loadVaultFonts(vaultPath: string): Promise<void> {
  const identity = captureVaultIdentity();
  let fonts: readonly ImportedFontData[];
  try {
    const result = await window.filo.invoke('font:list-imported', vaultPath);
    if (!result.success) return;
    fonts = result.fonts;
  } catch (err) {
    reportError('importedFonts.list', err, "Couldn't read this vault's imported fonts.");
    return;
  }
  if (!isStillSameVault(identity) || fonts.length === 0) return;
  const loaded = await registerImportedFonts(fonts);
  // The vault closed while the fonts loaded, after the swap's drop had run.
  // Remove only these faces: the next vault may have registered its own.
  if (!isStillSameVault(identity)) removeFaces(loaded.map((font) => font.face));
}

function removeFaces(faces: readonly FontFace[]): void {
  for (const face of faces) document.fonts.delete(face);
  registered = registered.filter((face) => !faces.includes(face));
}

/** Removes every font this vault registered. */
export function dropImportedFonts(): void {
  removeFaces(registered);
}

onVaultSwap('pre-swap', 'importedFonts', () => {
  dropImportedFonts();
});
