/**
 * CI gate: the frontmatter data-loss invariant (Audit2 1.7).
 *
 * Runs the dedicated property/fuzz suite that asserts NO write path silently
 * drops bytes it couldn't parse. For a corpus of hostile frontmatter (CRLF,
 * tabs, comments, anchors, quoted / special-char / numeric / bool tags,
 * flow / block / scalar shapes, duplicate keys) plus a fast-check fuzzer,
 * every tag op AND the body-only save path must either preserve the user's
 * data losslessly or refuse the write — never corrupt or erase frontmatter.
 *
 * The same suite also runs inside `test:unit:strict`; running it again here as
 * its own named gate makes the invariant a first-class, can't-be-silently-
 * dropped CI check — the "no metadata is ever silently lost" bar that closes
 * the Phase 1 (1.1–1.6) data-loss cluster.
 *
 * See src/tests/unit/frontmatterInvariant.test.ts.
 */
import { spawn } from 'node:child_process';

const TEST_FILE = 'src/tests/unit/frontmatterInvariant.test.ts';

const child = spawn('npx', ['vitest', 'run', TEST_FILE], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

child.on('error', (err) => {
  process.stderr.write(`[check-frontmatter-invariant] failed to spawn vitest: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0) {
    process.stderr.write(
      '\n[check-frontmatter-invariant] FRONTMATTER INVARIANT GATE FAILED.\n' +
        'A write path silently lost or corrupted frontmatter data. Every tag op and the\n' +
        "body-only save path must preserve the user's data losslessly OR refuse the write —\n" +
        'never drop a key, corrupt the YAML, or touch the body. See the failing case above\n' +
        'and src/tests/unit/frontmatterInvariant.test.ts.\n',
    );
  }
  process.exit(code ?? 1);
});
