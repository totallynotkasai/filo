/**
 * `ci:markdown-body-roundtrip` — pins the golden-corpus BODY round-trip test.
 *
 * Filo's core invariant is byte-faithful Markdown: opening a `.md` file and
 * saving it with no user edit must not change bytes. `ci:frontmatter-invariant`
 * covers frontmatter only; the BODY bytes the real TipTap editor emits after a
 * load → serialise cycle are pinned by
 * `src/tests/unit/markdownBodyRoundTrip.test.ts` against the fixture corpus in
 * `src/tests/unit/fixtures/markdown-body-roundtrip/` (added as the safety net
 * for the TipTap 2 → 3 / tiptap-markdown 0.8 → 0.9 upgrade — TrailingNode,
 * nested-span merging and `setContent`'s emit-by-default all shift bytes or
 * fire phantom writes silently).
 *
 * The test itself does the byte comparison; this gate only guarantees the net
 * can't be quietly removed or hollowed out:
 *   - the test file exists and still drives the REAL editor factory
 *     (`createTiptapEditor`) through the production load/serialise path
 *     (`loadMarkdownIntoEditor` + `editorMarkdown`), asserts the no-update-on-load
 *     invariant, and checks `isLossyMarkdownRoundTrip`;
 *   - the fixture corpus holds at least MIN_FIXTURES source files, including the
 *     "document ENDS in a heading / list / table / code block" shapes TipTap 3's
 *     TrailingNode would otherwise silently extend.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TEST_FILE = 'src/tests/unit/markdownBodyRoundTrip.test.ts';
const FIXTURE_DIR = 'src/tests/unit/fixtures/markdown-body-roundtrip';
const MIN_FIXTURES = 15;
const REQUIRED_FIXTURES = [
  'ends-heading.md',
  'ends-list.md',
  'ends-table.md',
  'ends-code-block.md',
  'tables.md',
  'task-lists.md',
  'nested-lists.md',
  'inline-html-spans.md',
  'tags.md',
  'blank-line-paragraphs.md',
  'code-blocks.md',
  'links-underline.md',
  // Audit-19 MD-3 — a body that OPENS with a horizontal-rule pair (behind real FM).
  'hr-leading-body.md',
];
const REQUIRED_TOKENS = [
  { token: /\bcreateTiptapEditor\s*\(/, why: 'drives the REAL editor factory, not a stub' },
  { token: /\bloadMarkdownIntoEditor\s*\(/, why: 'uses the production load path' },
  { token: /\beditorMarkdown\s*\(/, why: 'uses the production serialise path' },
  { token: /\bisLossyMarkdownRoundTrip\s*\(/, why: 'checks the lossy (read-only) verdict' },
  { token: /emits no update/, why: 'asserts loading a file does not fire onUpdate (phantom write)' },
  // Audit-19 MD-1 — a load is not an undoable step (Ctrl+Z after open emptied the note).
  { token: /load → undo is a no-op/, why: 'asserts Ctrl+Z right after a load changes nothing (MD-1)' },
  { token: /\\r\\n/, why: 'exercises CRLF bodies' },
];

const failures = [];

if (!existsSync(join(ROOT, TEST_FILE))) {
  failures.push(`${TEST_FILE} is missing`);
} else {
  const src = readFileSync(join(ROOT, TEST_FILE), 'utf8');
  for (const { token, why } of REQUIRED_TOKENS) {
    if (!token.test(src)) failures.push(`${TEST_FILE} — missing /${token.source}/ (${why})`);
  }
  if (/\b(?:it|describe)\.skip\b|\bit\.todo\b/.test(src)) {
    failures.push(`${TEST_FILE} — contains a skipped/todo test; the corpus must run in full`);
  }
}

if (!existsSync(join(ROOT, FIXTURE_DIR))) {
  failures.push(`${FIXTURE_DIR} is missing`);
} else {
  const sources = readdirSync(join(ROOT, FIXTURE_DIR)).filter(
    (f) => f.endsWith('.md') && !f.includes('.expected'),
  );
  if (sources.length < MIN_FIXTURES) {
    failures.push(`${FIXTURE_DIR} has ${sources.length} source fixtures (< ${MIN_FIXTURES})`);
  }
  for (const f of REQUIRED_FIXTURES) {
    if (!sources.includes(f)) failures.push(`${FIXTURE_DIR}/${f} is missing`);
  }
}

if (failures.length > 0) {
  console.error('[check-markdown-body-roundtrip] FAILED — the markdown body round-trip safety net regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nThe golden-corpus test pins the exact body bytes the editor writes after a\n' +
      'no-edit open. Restore the test / fixtures rather than deleting them; if an\n' +
      'editor upgrade legitimately changes output, update the `.expected.md`\n' +
      'baseline with a byte-by-byte justification in the commit message.',
  );
  process.exit(1);
}

console.log('[check-markdown-body-roundtrip] OK — body round-trip corpus test + fixtures present.');
process.exit(0);
