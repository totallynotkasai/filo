import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { assertSafeFilename, assertWithinVault } from '../utils/pathSecurity';
import { isActiveVault } from '../utils/activeVaultCheck';
import { fontsDirPath } from '../vault/configOps';
import { getVaultRoot } from './vault.ipc';
import { logMainError } from '../utils/mainLogger';
import { atomicWriteFile, uniqueFilePath } from '../vault/filenameUtils';

// Refuse to import font files larger than 25 MB and
// reject anything whose first four bytes don't match a recognised
// font magic. Stops a renderer that's been tricked into selecting a
// multi-GB file from streaming it through the context bridge, and
// keeps a renamed `.txt` from passing as a `.ttf` purely on extension.
const FONT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
// Font magic bytes:
//   - TTF / TrueType collection: 0x00 0x01 0x00 0x00 / 'true' / 'ttcf'
//   - OTF (CFF-flavoured OpenType): 'OTTO'
//   - WOFF: 'wOFF'
//   - WOFF2: 'wOF2'
const isFontMagic = (bytes: Buffer): boolean => {
  if (bytes.length < 4) return false;
  const u32 = bytes.readUInt32BE(0);
  // 0x00010000 = TTF; 0x74727565 = 'true' (OS X TrueType); 0x74746366 = 'ttcf'.
  if (u32 === 0x00010000 || u32 === 0x74727565 || u32 === 0x74746366) return true;
  const ascii = bytes.slice(0, 4).toString('ascii');
  return ascii === 'OTTO' || ascii === 'wOFF' || ascii === 'wOF2';
};

/** The file types `font:import` accepts, so `font:list-imported` reads back the same set. */
const FONT_EXTENSIONS = new Set(['.otf', '.ttf', '.woff', '.woff2']);

/**
 * Registers IPC handlers for font management.
 * Lists system fonts and allows importing custom .otf/.ttf files into the vault.
 */
export function registerFontHandlers(): void {
  /**
   * font:list-system — Returns a list of common system font family names.
   * Full enumeration of installed OS fonts requires native modules; we return
   * a well-known list that covers the most common fonts across platforms.
   */
  ipcMain.handle('font:list-system', async () => {
    // Common cross-platform fonts
    const fonts = [
      'Arial',
      'Arial Black',
      'Arial Rounded MT',
      'Calibri',
      'Cambria',
      'Comic Sans MS',
      'Consolas',
      'Courier New',
      'Georgia',
      'Helvetica',
      'Impact',
      'Lucida Console',
      'Palatino Linotype',
      'Segoe UI',
      'Tahoma',
      'Times New Roman',
      'Trebuchet MS',
      'Verdana',
    ];
    return fonts;
  });

  /**
   * font:list-imported — The fonts in the active vault's `.filo/fonts/`, as
   * bytes. The renderer registers them on every vault open: a `FontFace`
   * lasts only as long as the page, so an imported font would otherwise be
   * gone after a restart. The renderer can't read `.filo/` itself.
   */
  ipcMain.handle('font:list-imported', async (_event, vaultPath?: string) => {
    const activeVaultRoot = getVaultRoot();
    if (!vaultPath || !activeVaultRoot || !isActiveVault(vaultPath)) {
      return { success: false, fonts: [], error: 'Vault path mismatch' };
    }
    const fontsDir = fontsDirPath(activeVaultRoot);
    assertWithinVault(activeVaultRoot, fontsDir);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(fontsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { success: true, fonts: [] };
      logMainError('font:list-imported', err);
      return { success: false, fonts: [], error: 'Could not read the fonts folder' };
    }

    const fonts: { name: string; path: string; dataBase64: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const filePath = path.join(fontsDir, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > FONT_IMPORT_MAX_BYTES) continue;
        const bytes = await fs.promises.readFile(filePath);
        if (!isFontMagic(bytes)) continue;
        fonts.push({ name: path.parse(entry.name).name, path: filePath, dataBase64: bytes.toString('base64') });
      } catch (err) {
        logMainError(`font:list-imported ${entry.name}`, err);
      }
    }
    return { success: true, fonts };
  });

  /**
   * font:import — Opens a file dialog to select .otf/.ttf files, copies them
   * into the vault's fonts directory, and returns the font metadata.
   */
  ipcMain.handle('font:import', async (_event, vaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Import Custom Font',
      filters: [{ name: 'Font Files', extensions: ['otf', 'ttf', 'woff', 'woff2'] }],
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, fonts: [] };
    }

    // When `vaultPath` is supplied, the renderer is asking us to copy the
    // selected font files into `<vault>/.filo/fonts/`. The path is
    // renderer-supplied, so a compromised renderer could pass a system path
    // (e.g. `C:\Windows\System32`) and have us copy blobs into it. We
    // cross-check against the active vault root to bind the destination to
    // the vault that's actually open in this process. `vaultPath` is
    // required.
    const activeVaultRoot = getVaultRoot();
    if (!vaultPath || !activeVaultRoot || !isActiveVault(vaultPath)) {
      return { success: false, fonts: [], error: 'Vault path mismatch' };
    }
    const resolvedVaultRoot = activeVaultRoot;
    const fontsDir = fontsDirPath(activeVaultRoot);
    assertWithinVault(activeVaultRoot, fontsDir);
    await fs.promises.mkdir(fontsDir, { recursive: true });

    const imported: { name: string; path: string; dataBase64: string }[] = [];

    for (const filePath of result.filePaths) {
      const fileName = path.basename(filePath);
      const fontName = path.parse(fileName).name;

      // Pre-flight stat + magic check.
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        logMainError(`font:import:stat ${fileName}`, err);
        continue;
      }
      if (stat.size > FONT_IMPORT_MAX_BYTES) {
        logMainError(
          `font:import ${fileName}`,
          new Error(`Font file too large: ${stat.size} > ${FONT_IMPORT_MAX_BYTES}`),
        );
        continue;
      }
      let fd: fs.promises.FileHandle | null = null;
      try {
        fd = await fs.promises.open(filePath, 'r');
        const head = Buffer.alloc(4);
        await fd.read(head, 0, 4, 0);
        if (!isFontMagic(head)) {
          logMainError(
            `font:import ${fileName}`,
            new Error('File magic does not match a known font format'),
          );
          continue;
        }
      } catch (err) {
        logMainError(`font:import:magic ${fileName}`, err);
        continue;
      } finally {
        await fd?.close().catch(() => undefined);
      }

      // Font import copies a NEW file into `.filo/fonts/`; creation rules
      // apply on every platform so the imported font file remains portable.
      assertSafeFilename(fileName, { forCreation: true });

      // Collision-suffix loop so re-importing a font
      // with the same filename doesn't silently overwrite the prior
      // entry. Matches the pattern `copyFileToVault` uses for attachment
      // copies — `My Font.otf` → `My Font (2).otf` on collision.
      const parsedName = path.parse(fileName);
      const finalPath = await uniqueFilePath(fontsDir, parsedName.name, parsedName.ext);
      assertWithinVault(resolvedVaultRoot, finalPath);

      // Read the source then atomic-write to the vault so a crash
      // mid-copy can't leave a torn / partial font file behind.
      // atomicWriteFile takes a Buffer for binary content.
      const sourceBytes = await fs.promises.readFile(filePath);
      await atomicWriteFile(finalPath, sourceBytes);

      imported.push({ name: fontName, path: finalPath, dataBase64: sourceBytes.toString('base64') });
    }

    return { success: true, fonts: imported };
  });
}
