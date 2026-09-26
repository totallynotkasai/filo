import { parseDocument } from 'yaml';
import { splitFrontmatterFence } from '../notes/frontmatterFence';

/**
 * The lightweight frontmatter READ helpers for the non-editor paths (the vault
 * index + the template service). They use the same `yaml` package as the
 * note writer, so there is one parser for all frontmatter — a second
 * parser (e.g. gray-matter's js-yaml, which coerces `date:` → `Date`,
 * `1_000` → `1000`) would disagree and cause "looks changed but isn't" drift.
 * Gate `no-jsyaml` forbids js-yaml / gray-matter anywhere in the app.
 *
 * The editor read/write path uses the richer `parseMarkdownFile`
 * (`lib/editor/markdownSync.ts`: BOM flag + `hasFrontmatter` surface,
 * TipTap-adjacent). These helpers are the minimal twin the index/template code
 * needs and deliberately stay free of that module.
 */

/**
 * Splits raw markdown bytes into the verbatim frontmatter SOURCE (the bytes
 * between the `---` fences — no fences, no surrounding newline) and the body,
 * with the one fence parser the note writer uses (`splitFrontmatterFence`), so
 * the index and the editor always agree on where the body starts. A leading
 * BOM is skipped, so a Notepad-saved file's body matches the disk-read
 * gateway's view. Returns `rawFrontmatter: ''` and the whole (BOM-stripped)
 * input as `body` when there is no frontmatter block.
 */
export function splitFrontmatterSource(rawContent: string): {
  rawFrontmatter: string;
  body: string;
} {
  const { block, body } = splitFrontmatterFence(rawContent);
  return { rawFrontmatter: block?.source ?? '', body };
}

/**
 * Parses a YAML frontmatter SOURCE block (the bytes between the fences) into a
 * plain object with the `yaml` package — the SAME parser the note writer
 * uses. Calls `.toJS()` EVEN WHEN `parseDocument` reports recoverable errors
 * (`TAB_AS_INDENT`, `DUPLICATE_KEY`, …) so a malformed-but-recoverable block
 * still parses. The `yaml` core schema resolves no timestamp or merge tag, so
 * an unquoted `date:` stays a `string` and `<<: *a` a literal `<<`. Returns
 * `{}` for empty input, a non-object root (a bare scalar / sequence / flow
 * mapping), or an unresolvable alias / missing-anchor merge whose `.toJS()`
 * throws — the caller keeps whatever it had rather than crashing.
 */
export function parseFrontmatterObject(yamlSource: string): Record<string, unknown> {
  if (!yamlSource.trim()) return {};
  try {
    // logLevel 'error': collection keys are stringified on purpose (see markdownSync).
    const loaded = parseDocument(yamlSource, { logLevel: 'error' }).toJS();
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      return loaded as Record<string, unknown>;
    }
  } catch {
    /* unparseable / alias-poison — fall through to {} */
  }
  return {};
}
