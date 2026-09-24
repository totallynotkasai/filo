/**
 * Strict unit-test runner.
 *
 * Runs `vitest run` and fails if its output (stdout AND stderr — Vite's
 * transform warnings go to stdout) contains a known noise pattern. Each
 * pattern is a class of problem that passes silently otherwise:
 *   - a missing `window.filo` mock (`TypeError … reading 'invoke'`);
 *   - a duplicate key in an object literal (the first value is dead);
 *   - the `yaml` collection-key warning, which production silences with
 *     `logLevel: 'error'` — seeing it means a parse site lost that option;
 *   - Svelte runtime warnings for an effect loop or an unsafe state mutation.
 * Legitimate failure-path tests that route IPC handlers to throw are NOT
 * flagged — they produce `[dirtyFlag] Failed to mark dirty: Error: <user
 * message>` lines, which are asserted behaviour, not noise.
 *
 * Use this script in CI; locally `npm run test:unit` remains unchanged so
 * developers see all output without a failing gate.
 */
import { spawn } from 'node:child_process';

const NOISE_PATTERNS = [
  /TypeError: Cannot read properties of undefined \(reading 'invoke'\)/,
  /TypeError: Cannot read properties of undefined \(reading 'filo'\)/,
  /Duplicate key ".*" in object literal/,
  /Keys with collection values will be stringified/,
  /effect_update_depth_exceeded/,
  /\[svelte\] (?:state_unsafe_mutation|ownership_invalid_mutation)/,
];

const child = spawn('npx', ['vitest', 'run'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
  shell: true,
});

const stderrBuf = [];
const stdoutBuf = [];

function tee(src, dest, buf) {
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    dest.write(chunk);
    buf.push(chunk);
  });
}

tee(child.stdout, process.stdout, stdoutBuf);
tee(child.stderr, process.stderr, stderrBuf);

child.on('error', (err) => {
  process.stderr.write(`[test-unit-strict] failed to spawn vitest: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  const combined = stderrBuf.join('') + stdoutBuf.join('');
  const offending = [];
  for (const line of combined.split('\n')) {
    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(line)) {
        offending.push(line);
        break;
      }
    }
  }
  if (offending.length > 0) {
    process.stderr.write(
      '\n[test-unit-strict] Test hygiene gate failed — these lines must not appear:\n',
    );
    for (const line of offending) process.stderr.write(`  ${line}\n`);
    process.stderr.write(
      '\nA missing window.filo mock: use installFiloMock() from src/tests/helpers/filoBridge.ts,\n' +
        'or rely on the default no-op stub auto-installed by src/tests/setup.ts.\n' +
        'A duplicate key: delete the dead first occurrence.\n' +
        "A yaml collection-key warning: pass { logLevel: 'error' } to that parseDocument call.\n" +
        'A Svelte effect-loop / unsafe-mutation warning: fix the effect; it loops or mutates state in a derived.\n',
    );
    process.exit(1);
  }
  process.exit(0);
});
