/**
 * Strict unit-test runner.
 *
 * Runs `vitest run` and fails if stderr contains the noise pattern fixed by
 * Phase 4 ("Test Hygiene"). The pattern is scoped narrowly to the
 * regression we're guarding against — a missing `window.filo` mock causing
 * `TypeError: Cannot read properties of undefined (reading 'invoke')` from
 * `dirtyFlagRecovery.markDirty`. Legitimate failure-path tests that route
 * IPC handlers to throw are NOT flagged — they produce
 * `[dirtyFlag] Failed to mark dirty: Error: <user message>` lines which are
 * asserted behavior, not infrastructure noise.
 *
 * Use this script in CI; locally `npm run test:unit` remains unchanged so
 * developers see all output without a failing gate.
 */
import { spawn } from 'node:child_process';

const NOISE_PATTERNS = [
  /TypeError: Cannot read properties of undefined \(reading 'invoke'\)/,
  /TypeError: Cannot read properties of undefined \(reading 'filo'\)/,
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
      '\nThis usually means a test exercises a code path that calls window.filo.invoke()\n' +
        'without a mock installed. Use installFiloMock() from src/tests/helpers/filoBridge.ts,\n' +
        'or rely on the default no-op stub auto-installed by src/tests/setup.ts.\n',
    );
    process.exit(1);
  }
  process.exit(0);
});
