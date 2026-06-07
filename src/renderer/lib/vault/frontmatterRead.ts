import { parseDocument } from 'yaml';

/**
 * M2 (Audit-13) — the lightweight frontmatter READ helpers for the non-editor
 * paths (the vault index + the template service). Both used to route through
 * `gray-matter`, whose bundled `js-yaml` v3 (YAML 1.1) coerces an unquoted
 * `date:` → `Date`, `0b1010` → `10`, and `1_000` → `1000`. That made gray-matter
 * a SECOND frontmatter parser disagreeing with the `yaml` package the read/write
 * gateway uses — the cross-parser "looks changed but isn't" drift that was the
 * recurring M2 class. Routing these paths through the `yaml` package here makes
 * "one parser for all frontmatter" structural, not aspirational;
 * `ci:no-jsyaml-in-frontmatter` now also forbids `gray-matter` so the second
 * parser can't creep back.
 *
 * The editor read/write path uses the richer `parseMarkdownFile`
 * (`lib/editor/markdownSync.ts`: BOM flag + `hasFrontmatter` surface,
 * TipTap-adjacent). These helpers are the minimal twin the index/template code
 * needs and deliberately stay free of that module.
 */

/**
 * Splits raw markdown bytes into the verbatim frontmatter SOURCE (the bytes
 * between the `---` fences — no fences, no surrounding newline) and the body.
 * Uses the SAME fence regex as `parseMarkdownFile` / `parseMarkdown` — including
 * the Audit-4 DI-17 (M9) `[ \t]*` tolerance for a trailing space an editor left
 * on a fence line — and strips a leading BOM so a Notepad-saved file's body
 * matches the disk-read gateway's view. Returns `rawFrontmatter: ''` and the
 * whole (BOM-stripped) input as `body` when there is no frontmatter block.
 */
export function splitFrontmatterSource(rawContent: string): {
  rawFrontmatter: string;
  body: string;
} {
  // allow-bom-sniff: receives raw on-disk bytes (vault:read-file-text) for the index + template reads
  const stripped = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(stripped);
  if (!match) return { rawFrontmatter: '', body: stripped };
  return { rawFrontmatter: match[1] ?? '', body: stripped.slice(match[0].length) };
}

/**
 * Parses a YAML frontmatter SOURCE block (the bytes between the fences) into a
 * plain object with the `yaml` package — the SAME parser the read/write gateway
 * uses. Calls `.toJS()` EVEN WHEN `parseDocument` reports recoverable errors
 * (`TAB_AS_INDENT`, `DUPLICATE_KEY`, …) so a malformed-but-recoverable block
 * still parses, but WITHOUT gray-matter's js-yaml coercion: the `yaml` core
 * schema resolves no timestamp or merge tag, so an unquoted `date:` stays a
 * `string` (DI-01) and `<<: *a` a literal `<<` (DI-05). Returns `{}` for empty
 * input, a non-object root (a bare scalar / sequence / flow mapping), or an
 * unresolvable alias / missing-anchor merge whose `.toJS()` throws (the H2
 * class) — the caller keeps whatever it had rather than crashing.
 */
export function parseFrontmatterObject(yamlSource: string): Record<string, unknown> {
  if (!yamlSource.trim()) return {};
  try {
    const loaded = parseDocument(yamlSource).toJS();
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      return loaded as Record<string, unknown>;
    }
  } catch {
    /* unparseable / alias-poison — fall through to {} */
  }
  return {};
}
