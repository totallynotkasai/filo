// Runs the CI gate checks.
//
//   node scripts/gates/run.mjs                 all checks
//   node scripts/gates/run.mjs --only a,b      just these check ids
//   node scripts/gates/run.mjs --group writePath
//   node scripts/gates/run.mjs --list          list groups and check ids
//
// Exits 1 when any check reports a violation (or throws).
import { createContext } from './lib.mjs';
import * as codebase from './codebase.mjs';
import * as commands from './commands.mjs';
import * as components from './components.mjs';
import * as ipcSecurity from './ipcSecurity.mjs';
import * as markdownFormat from './markdownFormat.mjs';
import * as vaultIdentity from './vaultIdentity.mjs';
import * as writePath from './writePath.mjs';

const GROUPS = { writePath, markdownFormat, vaultIdentity, ipcSecurity, commands, components, codebase };

function parseArgs(argv) {
  const opts = { only: null, group: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a.startsWith('--only')) opts.only = new Set(value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--group')) opts.group = value();
    else if (a === '--list') opts.list = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const all = Object.entries(GROUPS).flatMap(([group, mod]) => mod.checks.map((c) => ({ ...c, group })));

const ids = new Set();
for (const c of all) {
  if (ids.has(c.id)) throw new Error(`duplicate check id: ${c.id}`);
  ids.add(c.id);
}

if (opts.list) {
  for (const [group, mod] of Object.entries(GROUPS)) {
    console.log(group);
    for (const c of mod.checks) console.log(`  ${c.id.padEnd(32)} ${c.title}`);
  }
  process.exit(0);
}
if (opts.group && !GROUPS[opts.group]) {
  console.error(`unknown group "${opts.group}" (have: ${Object.keys(GROUPS).join(', ')})`);
  process.exit(2);
}
const unknown = opts.only ? [...opts.only].filter((id) => !ids.has(id)) : [];
if (unknown.length) {
  console.error(`unknown check id(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const selected = all.filter((c) => (!opts.only || opts.only.has(c.id)) && (!opts.group || c.group === opts.group));
const ctx = createContext(process.cwd());
const started = Date.now();
let failed = 0;

for (const check of selected) {
  let violations;
  try {
    violations = check.run(ctx);
  } catch (err) {
    violations = [{ message: `check crashed: ${err.stack ?? err}` }];
  }
  if (violations.length === 0) {
    console.log(`PASS  ${check.id}`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${check.id} — ${violations.length} violation(s): ${check.title}`);
  for (const v of violations) {
    const where = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}: ` : '';
    console.log(`        ${where}${v.message}`);
  }
  if (check.hint) console.log(`      fix: ${check.hint}`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${selected.length - failed}/${selected.length} gate checks passed in ${secs}s`);
process.exit(failed > 0 ? 1 : 0);
