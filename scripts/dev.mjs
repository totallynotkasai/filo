/**
 * Cross-platform launcher for electron-vite.
 *
 *   node scripts/dev.mjs             dev server and Electron, on your own profile
 *   node scripts/dev.mjs --scratch   the same on a scratch profile (`filo-dev`
 *                                    beside your own), so a dev run opens none
 *                                    of your vaults
 *   node scripts/dev.mjs --preview   builds into dist-preview/ and runs that build
 *   node scripts/dev.mjs --start     runs the last dist-preview/ build again,
 *                                    without building
 *
 * Arguments after `--` go to Electron (`-- --user-data-dir=<folder>`).
 *
 * The preview builds into a folder of its own because `npm run build` and the
 * test suites rebuild dist/, and a rebuild deletes the code files a running
 * copy still loads the first time the Raw view, Replace or the Tags Browser
 * opens.
 * Nothing but this script writes dist-preview/.
 *
 * Removes ELECTRON_RUN_AS_NODE (set by VS Code's terminal) so Electron
 * initializes properly.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.ELECTRON_RUN_AS_NODE;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_DIR = 'dist-preview';
const ELECTRON_VITE = join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const flags = split === -1 ? argv : argv.slice(0, split);
const electronArgs = split === -1 ? [] : argv.slice(split + 1);

if (flags.includes('--scratch')) {
  // Beside Electron's own profile folder, so it is easy to find and clear.
  const appData = process.env.APPDATA ?? join(homedir(), '.config');
  electronArgs.push(`--user-data-dir=${join(appData, 'filo-dev')}`);
}

let viteArgs;
if (flags.includes('--start')) {
  if (!existsSync(join(ROOT, PREVIEW_DIR, 'main', 'main.js'))) {
    console.error(`No build in ${PREVIEW_DIR}/ yet: run \`npm run preview\` first.`);
    process.exit(1);
  }
  viteArgs = ['preview', '--skipBuild', '--entry', PREVIEW_DIR];
} else if (flags.includes('--preview')) {
  writePreviewManifest();
  viteArgs = ['preview', '--outDir', PREVIEW_DIR, '--entry', PREVIEW_DIR];
} else {
  viteArgs = ['dev'];
}

/**
 * Electron starts the preview from its folder, reading this package.json for
 * the entry and the app's name. The name must be package.json's own: Electron
 * names the profile folder after it, and the preview runs on your profile.
 * The build empties only the folders inside dist-preview/, so this survives it.
 */
function writePreviewManifest() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = { name: pkg.name, version: pkg.version, private: true, main: 'main/main.js' };
  if (pkg.type) manifest.type = pkg.type;
  mkdirSync(join(ROOT, PREVIEW_DIR), { recursive: true });
  writeFileSync(join(ROOT, PREVIEW_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const child = spawn(
  process.execPath,
  [ELECTRON_VITE, ...viteArgs, ...(electronArgs.length > 0 ? ['--', ...electronArgs] : [])],
  { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], env: process.env },
);

// Chromium's bundled DevTools spams CDP `Autofill.*` calls that Electron
// doesn't implement. The errors are harmless but drown out real output.
const NOISE = /Autofill\.(enable|setAddresses)/;

function pipeFiltered(src, dest) {
  let buf = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      if (!NOISE.test(line)) dest.write(line);
    }
  });
  src.on('end', () => {
    if (buf && !NOISE.test(buf)) dest.write(buf);
  });
}

pipeFiltered(child.stdout, process.stdout);
pipeFiltered(child.stderr, process.stderr);

child.on('exit', (code) => process.exit(code ?? 0));
