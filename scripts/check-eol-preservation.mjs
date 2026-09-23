/**
 * Audit-7 H2 / Phase 7 — `ci:eol-preservation`.
 *
 * Pins the one formatting invariant the LF-only test suite never exercised and
 * the Audit-7 sweep found broken: a dirty-frontmatter rewrite must re-apply the
 * FILE's line ending to the bytes it emits, instead of hard-coding `\n`.
 *
 * Background (H2): `patchFrontmatterSourceCst` normalises the on-disk
 * frontmatter source to LF — its docstring explicitly says "the caller
 * re-applies the file's line ending." `assembleMarkdownFile`'s clean
 * passthrough (`emitWithRawFrontmatter`) and `tagRewriter.reassemble` honour
 * that; the dirty `objectHasKeys` branch did NOT — it emitted the FM block +
 * `---` fences with a literal `\n`. So a CRLF note's first metadata edit
 * (Properties popup / editor) silently flipped its frontmatter to LF:
 *   - a permanently MIXED file (CRLF body + LF FM, because the Properties popup
 *     sources `body` from `diskBody` verbatim), or
 *   - a whole-file CRLF -> LF flip when an editor edit also dirtied the FM
 *     (tiptap bodies are already LF).
 * No content lost, but byte-level churn on every metadata edit + git/merge noise
 * — exactly the kind of silent regression a gate must hold shut.
 *
 * The fix threads the file eol through `assembleMarkdownFile`'s dirty path:
 *   const eol = detectFrontmatterEol(options, body);
 *   const fmBlock = `---\n${yamlText}\n---\n`.replace(/\n/g, eol);
 *   const trailing = body.endsWith('\n') ? '' : eol;
 * This gate asserts those three load-bearing tokens survive. A revert to the
 * hard-coded `\n` fences removes the `.replace(/\n/g, eol)` (and usually the
 * helper) -> the gate fires. The `---\n` template literal itself is NOT
 * forbidden (it is the pre-`.replace` input), so the gate keys on the eol
 * RE-APPLICATION, not the literal fence.
 *
 * Audit-8 M1 / Phase 5 — HARDENING. A token-presence check pins that the eol
 * re-apply EXISTS; it cannot catch a WRONG eol value (the real M1 hole was that
 * a single-line FM has no internal `\r\n`, so a truthy stripped-FM source
 * short-circuited the CRLF-carrying body and the helper returned `'\n'` for a
 * CRLF file). The real protection is the behavioral single-line-CRLF matrix in
 * `assembleMarkdownEngine.test.ts`, which drives the WHOLE assemble and asserts
 * the output bytes stay CRLF. So this gate ALSO asserts that matrix is present
 * (its describe block + the gateway-threaded `eol: '\r\n'` capability that is
 * the crux of the robust fix) — the token pin stays a tripwire, the behavioral
 * matrix is the substance, and neither can be silently deleted without CI
 * firing.
 *
 * Audit-13 M8 — a THIRD target: the DocumentEditor adopt-path hydrate. TextTile's
 * adopt path sniffs CRLF from the adopted body and threads it into `markHydrated`
 * so the gateway honours it on the first write; DocumentEditor's twin left
 * `eol` undefined, so a single-line-FM CRLF file flipped whole-file to LF on the
 * first body save (single-pane sessions only, which is why prior audits missed
 * it). The fix mirrors TextTile; this gate pins both tokens (the body-sniff +
 * the threaded `adoptEol` arg) so the adopt path can't silently drop the eol
 * again. Behavioral proof: `documentEditorAdoptEol.test.ts`.
 *
 * Heuristic token-presence check (comments stripped first so a doc-comment that
 * merely describes the fix can't satisfy it) — same pragmatic style as
 * `check-awaited-writes-bounded.mjs`, not an AST walk.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Strip block + line comments so a doc-comment mention can't satisfy a check. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const checks = [
  {
    file: 'src/renderer/lib/editor/markdownSync.ts',
    label: 'assembleMarkdownFile re-applies the file eol on the dirty FM path',
    required: [
      {
        token: /function\s+detectFrontmatterEol\b/,
        why: 'the file-eol derivation helper exists',
      },
      {
        token: /const\s+eol\s*=\s*detectFrontmatterEol\s*\(/,
        why: 'the dirty `objectHasKeys` branch derives the file eol',
      },
      {
        token: /\.replace\(\s*\/\\n\/g\s*,\s*eol\s*\)/,
        why: 'the FM block + `---` fences re-apply the file eol (no hard-coded \\n)',
      },
    ],
  },
  {
    file: 'src/tests/unit/assembleMarkdownEngine.test.ts',
    label: 'the single-line-CRLF behavioral matrix (A8-M1) — the real eol-value protection — is present',
    required: [
      {
        token: /single-line frontmatter eol \(A8-M1\)/,
        why: 'the A8-M1 single-line-FM describe block (every prior CRLF row used >=2-key FM, which hid the bug behind an internal \\r\\n)',
      },
      {
        token: /eol:\s*'\\r\\n'/,
        why: 'a row drives the gateway-threaded `eol` (the only CRLF signal that survives an LF editor body) — the crux of the robust fix',
      },
    ],
  },
  {
    file: 'src/renderer/components/boards/DocumentEditor.svelte',
    label: 'the DocumentEditor adopt path threads the sniffed file eol into markHydrated (A13-M8)',
    required: [
      {
        token: /const\s+adoptEol\s*=\s*docState\.body\.includes/,
        why: 'the adopt path sniffs CRLF from the adopted body (mirrors TextTile)',
      },
      {
        token: /markHydrated\([^)]*adoptEol/,
        why: 'the sniffed eol is threaded into markHydrated — else a single-line-FM CRLF file flips to LF on the first body save',
      },
    ],
  },
];

const failures = [];
for (const check of checks) {
  let code;
  try {
    code = stripComments(readFileSync(join(ROOT, check.file), 'utf8'));
  } catch (err) {
    failures.push(`${check.file} — could not read: ${err.message}`);
    continue;
  }
  for (const { token, why } of check.required) {
    if (!token.test(code)) {
      failures.push(`${check.file} — missing /${token.source}/ (${why}) — ${check.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[check-eol-preservation] FAILED — Audit-7 H2 line-ending invariant regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nA dirty-frontmatter rewrite must re-apply the FILE\'s line ending to the\n' +
      'frontmatter block + `---` fences it emits, not hard-code `\\n`. The CST\n' +
      'engine (and the dump fallback) normalise to LF, so the dirty branch in\n' +
      '`assembleMarkdownFile` must restore the original eol:\n' +
      '  const eol = detectFrontmatterEol(options, body);\n' +
      '  const fmBlock = `---\\n${yamlText}\\n---\\n`.replace(/\\n/g, eol);\n' +
      '  const trailing = body.endsWith(\'\\n\') ? \'\' : eol;\n' +
      'Without it, a CRLF note flips its frontmatter to LF on the first metadata\n' +
      'edit (mixed file) or flips the whole file when an editor edit dirties the FM.\n' +
      '\nThe token pin is only a tripwire — it cannot catch a WRONG eol value. The\n' +
      'real protection is the single-line-CRLF behavioral matrix (A8-M1) in\n' +
      'src/tests/unit/assembleMarkdownEngine.test.ts, which drives the whole\n' +
      'assemble and asserts the output bytes stay CRLF. Restore both the\n' +
      'production re-apply (AUDIT7 H2) and that matrix (AUDIT8 M1).',
  );
  process.exit(1);
}

console.log(
  '[check-eol-preservation] OK — dirty-FM emit path re-applies the file line ending, ' +
    'the A8-M1 single-line-CRLF behavioral matrix is present, ' +
    'and the DocumentEditor adopt path threads the sniffed eol (A13-M8).',
);
process.exit(0);
