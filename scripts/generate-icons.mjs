/**
 * Generate platform-specific icons for Electron-builder packaging.
 *
 * Reads `resources/icon.svg` (1024×1024) and produces:
 *   - resources/icon.png   (1024×1024, used by Linux + electron-builder fallback)
 *   - resources/icon.ico   (multi-size: 16,24,32,48,64,128,256)
 *   - resources/icon.icns  (multi-size: 16,32,64,128,256,512,1024)
 *
 * Requires `sharp` and `png-to-ico` (devDependencies — installed only
 * when you intend to package). On macOS, `icns` generation also needs
 * `png2icons`. If a converter is missing, the script logs and skips
 * that target rather than failing the whole run.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const resourcesDir = join(root, 'resources');
const svgPath = join(resourcesDir, 'icon.svg');

if (!existsSync(svgPath)) {
  console.error(`Source icon not found: ${svgPath}`);
  process.exit(1);
}

mkdirSync(resourcesDir, { recursive: true });

const svgBuffer = readFileSync(svgPath);

// Each caller writes its import out (`() => import('sharp')`) rather than
// passing a name, so knip can see the converters are used.
async function optionalImport(load) {
  try {
    return await load();
  } catch {
    return null;
  }
}

async function rasterise() {
  const sharpMod = await optionalImport(() => import('sharp'));
  if (!sharpMod) {
    console.error('sharp is not installed. Install with: npm i -D sharp png-to-ico png2icons');
    process.exit(1);
  }
  const sharp = sharpMod.default ?? sharpMod;

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const buffers = {};
  for (const size of sizes) {
    buffers[size] = await sharp(svgBuffer).resize(size, size).png().toBuffer();
  }

  // 1024×1024 master PNG (Linux + fallback)
  writeFileSync(join(resourcesDir, 'icon.png'), buffers[1024]);
  console.log('Wrote resources/icon.png (1024×1024)');

  // ICO (Windows) — multi-size
  const pngToIco = await optionalImport(() => import('png-to-ico'));
  if (pngToIco) {
    const pngToIcoFn = pngToIco.default ?? pngToIco;
    const ico = await pngToIcoFn([16, 24, 32, 48, 64, 128, 256].map((s) => buffers[s]));
    writeFileSync(join(resourcesDir, 'icon.ico'), ico);
    console.log('Wrote resources/icon.ico');
  } else {
    console.warn('png-to-ico not installed — skipping resources/icon.ico');
  }

  // ICNS (macOS) — multi-size
  const png2icons = await optionalImport(() => import('png2icons'));
  if (png2icons) {
    const lib = png2icons.default ?? png2icons;
    const icns = lib.createICNS(buffers[1024], lib.BICUBIC, 0);
    if (icns) {
      writeFileSync(join(resourcesDir, 'icon.icns'), icns);
      console.log('Wrote resources/icon.icns');
    } else {
      console.warn('png2icons returned null for ICNS — skipping');
    }
  } else {
    console.warn('png2icons not installed — skipping resources/icon.icns');
  }
}

rasterise().catch((err) => {
  console.error(err);
  process.exit(1);
});
