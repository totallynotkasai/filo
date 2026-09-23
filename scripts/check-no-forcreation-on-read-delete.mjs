/**
 * #20 — read/delete IPC handlers must never pass `forCreation: true`.
 *
 * `assertSafeFilename` / `assertSafeRelativePath` accept `{ forCreation: true }`
 * to enforce the Windows-only filename rules (illegal chars `<>:"|?*`, reserved
 * DOS names like CON/NUL) on EVERY platform — correct for CREATION channels so
 * a new file stays portable to a Windows collaborator. But applying it to a
 * READ or DELETE handler is a regression: it would reject a legitimately-
 * existing file named `2025:01:15.md` (created on POSIX) or `CON.md`, making
 * the file impossible to open or remove from inside Filo. 6.3.P1/P2 platform-
 * gated these to win32-by-default; this gate prevents the gate from creeping
 * back onto a read/delete path.
 *
 * The gate walks `src/main/ipc/*.ts`, splits each file into `ipcMain.handle /
 * on / once('<channel>', ...)` regions, and for every channel whose name reads
 * or deletes (matches `read` / `delete` / `stat` / `exists`) asserts the region
 * contains no `forCreation: true`. Comments are stripped first so the
 * explanatory `// forCreation: true ...` notes on creation handlers don't
 * false-positive.
 *
 * Scope note: creation helpers in non-IPC modules (`vault/fileOps.ts`,
 * `vault/configOps.ts`) legitimately pass `forCreation: true` and are out of
 * scope — they're only reachable from creation channels, and a channel→intent
 * mapping there isn't statically available.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const IPC_DIR = join(ROOT, 'src/main/ipc');

const READ_DELETE_RE = /(?:read|delete|stat|exists)/i;
const FORCREATION_RE = /forCreation\s*:\s*true/;

function toPosix(p) {
  return p.split(sep).join('/');
}

/** Strip block + line comments while preserving offsets (length-for-length). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (full, lead) => lead + ' '.repeat(full.length - lead.length));
}

let tsFiles = [];
try {
  tsFiles = readdirSync(IPC_DIR)
    .filter((n) => n.endsWith('.ts'))
    .map((n) => join(IPC_DIR, n))
    .filter((p) => statSync(p).isFile());
} catch (err) {
  console.error(`[check-no-forcreation-on-read-delete] FAILED — couldn't read ${toPosix(relative(ROOT, IPC_DIR))}: ${err.message}`);
  process.exit(1);
}

const offenders = [];

for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const code = stripComments(readFileSync(abs, 'utf8'));

  // Collect every handler registration with its channel + source offset.
  const regRe = /ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/g;
  const regs = [];
  let m;
  while ((m = regRe.exec(code)) !== null) {
    regs.push({ channel: m[1], start: m.index });
  }

  // Each handler's body span runs from its registration to the next one
  // (or EOF). Check only read/delete channels for a forCreation:true pass.
  for (let i = 0; i < regs.length; i++) {
    const { channel, start } = regs[i];
    if (!READ_DELETE_RE.test(channel)) continue;
    const end = i + 1 < regs.length ? regs[i + 1].start : code.length;
    const body = code.slice(start, end);
    if (FORCREATION_RE.test(body)) {
      offenders.push({ rel, channel });
    }
  }
}

if (offenders.length > 0) {
  console.error('[check-no-forcreation-on-read-delete] FAILED — read/delete IPC handlers passing forCreation:true:');
  for (const { rel, channel } of offenders) {
    console.error(`  ${rel} — channel "${channel}"`);
  }
  console.error(
    '\nforCreation:true enforces Windows-only filename rules on every platform — correct for\n' +
      'CREATION channels, but a read/delete handler must remain able to open/remove a file\n' +
      'that legitimately exists with a Windows-illegal name (e.g. `2025:01:15.md`, `CON.md`).\n' +
      'Drop the option from the read/delete path (let it platform-gate to win32 by default).',
  );
  process.exit(1);
}

console.log(`[check-no-forcreation-on-read-delete] OK — ${tsFiles.length} IPC files scanned, no read/delete handler enforces forCreation.`);
process.exit(0);
