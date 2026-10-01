/**
 * Vault-wide Search query parser.
 *
 * Splits a raw search string into:
 *  - structured operators (`tag:`, `board:`, `has:`, `property:`, `type:`)
 *  - a bare regex literal (`/pattern/` or `/pattern/iflags`)
 *  - free-text remainder (matched against titles and bodies by `runSearch`)
 *
 * Operator grammar:
 *   tag:value           — frontmatter tag match (leading `#` optional, case-insensitive)
 *   board:name          — restrict matches to a single board (case-insensitive, exact match)
 *   has:connections     — tiles with at least one connection
 *   property:key=value  — frontmatter property equals (case-insensitive key, exact value)
 *   type:tile-type      — tile type discriminator (text|image|video|audio|file|link|iframe|timer)
 *
 * A query with no operator is searched for exactly as typed, spaces and quotes
 * included, as an editor's Find does: ` - ` finds a spaced hyphen, not every
 * hyphen, and two spaces find a double space. With an operator, whitespace
 * separates tokens and a quoted value (`"…"`) preserves embedded whitespace.
 * A backslash escape lets a literal colon survive inside an operator value, so
 * `tag:#has\:colon` parses as a single tag `#has:colon`. Outside operator values,
 * backslashes are not interpreted (so plain text `C:\foo` remains intact).
 *
 * Regex syntax: a token starting AND ending with `/` (or `/<flags>`) is parsed
 * as a JavaScript regex. Invalid regexes degrade to free text so the user
 * doesn't lose the query while editing.
 *
 * Pure function — no I/O, no Svelte state. Lives in `lib/search/` so the
 * vault-wide Search store, the find/replace command, and the unit tests can
 * all share the same grammar.
 */

import { TILE_TYPES, type TileType } from '../../schema/tile';

export type OperatorFilter =
  | { kind: 'tag'; value: string }
  | { kind: 'board'; value: string }
  | { kind: 'has-connections' }
  | { kind: 'property'; key: string; value: string }
  | { kind: 'type'; value: TileType };

export interface ParsedQuery {
  /** Structured operators ANDed together when filtering candidate files. */
  operators: OperatorFilter[];
  /**
   * The text to find: the whole query as typed when it has no operator,
   * otherwise the tokens left over, joined with single spaces. Empty when
   * only operators / regex are present.
   */
  freeText: string;
  /** Compiled regex when the query is a bare `/pattern/` literal; null otherwise. */
  regex: RegExp | null;
  /** Original input string, kept verbatim for round-tripping into the panel state. */
  raw: string;
}

const TILE_TYPE_SET: ReadonlySet<string> = new Set(TILE_TYPES);

/**
 * Tokenises the input into operator-aware tokens. Quoted strings (`"…"`) and
 * escaped colons (`\\:`) inside operator values are preserved. The tokeniser
 * never throws — malformed input degrades to plain text tokens that the
 * caller then routes into `freeText`.
 */
function tokenise(raw: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  let escape = false;

  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf);
      buf = '';
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      // Only honour the escape when it follows a colon-operator prefix so
      // plain-text `C:\foo` keeps the backslash literal. Heuristic: look back
      // for a colon since the last whitespace token.
      const lastWs = buf.lastIndexOf(' ');
      const fragment = lastWs >= 0 ? buf.slice(lastWs + 1) : buf;
      if (fragment.includes(':')) {
        escape = true;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ' ' && !inQuote) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Detects a bare regex literal `/pattern/` (with optional flags) and returns
 * a compiled RegExp. Returns null on syntax error so the caller falls back to
 * free-text. Flags are validated against the standard JS set.
 */
function tryParseRegex(token: string): RegExp | null {
  if (token.length < 2 || token[0] !== '/') return null;
  const lastSlash = token.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const pattern = token.slice(1, lastSlash);
  const flags = token.slice(lastSlash + 1);
  if (!/^[gimsuy]*$/.test(flags)) return null;
  // Add 'g' if missing so the panel can find every match without the caller
  // having to remember; preserve user-supplied flags (i, m, s, u) verbatim.
  const finalFlags = flags.includes('g') ? flags : flags + 'g';
  try {
    return new RegExp(pattern, finalFlags);
  } catch {
    return null;
  }
}

/**
 * Splits a single token into operator + value where applicable.
 *
 * Returns `null` when the token isn't a known operator (caller routes to
 * free text or regex). Unknown operator prefixes (e.g. `foo:bar`) also
 * return null so misspelled operators don't disappear into the operator
 * filter list — they show up as plain text the user can see and correct.
 */
function tryParseOperator(token: string): OperatorFilter | null {
  // Find the FIRST colon (operator delimiter). Subsequent colons inside the
  // value survive verbatim — `property:status=in:progress` parses as
  // key=status, value=in:progress. Escaped colons (`\\:`) have already been
  // converted to literal colons by the tokeniser.
  const colonAt = token.indexOf(':');
  if (colonAt <= 0) return null;
  const op = token.slice(0, colonAt).toLowerCase();
  const value = token.slice(colonAt + 1);
  if (!value) return null;

  switch (op) {
    case 'tag': {
      // Strip leading `#` so the index lookup (which stores bare names) is
      // a direct hit. Empty after the strip means the token degrades to
      // free text.
      const trimmed = value.replace(/^#/, '').trim();
      if (!trimmed) return null;
      return { kind: 'tag', value: trimmed };
    }
    case 'board': {
      const trimmed = value.trim();
      if (!trimmed) return null;
      return { kind: 'board', value: trimmed };
    }
    case 'has': {
      // Only `has:connections` is meaningful today — the spec doesn't list
      // other `has:` values. Unknown sub-operators degrade to free text.
      if (value.toLowerCase() === 'connections') return { kind: 'has-connections' };
      return null;
    }
    case 'property': {
      const eq = value.indexOf('=');
      if (eq <= 0) return null;
      const key = value.slice(0, eq).trim();
      const val = value.slice(eq + 1).trim();
      if (!key || !val) return null;
      return { kind: 'property', key, value: val };
    }
    case 'type': {
      const lower = value.trim().toLowerCase();
      if (!TILE_TYPE_SET.has(lower)) return null;
      return { kind: 'type', value: lower as TileType };
    }
    default:
      return null;
  }
}

/**
 * Parses a search query string into a structured `ParsedQuery`. Always
 * returns a value — degenerate input becomes an empty parse with the
 * original `raw` preserved. Callers test `isEmpty(parsed)` before running
 * any filter so empty queries don't enumerate the whole vault.
 */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (!trimmed) {
    // Only spaces is a search too: two of them find a double space to clean up.
    return { operators: [], freeText: raw, regex: null, raw };
  }

  // Special-case: the WHOLE trimmed input is a bare regex. We don't allow
  // mixing regex with operators today — the regex form is "search every
  // file's content with this pattern", which is independent of operator
  // filtering. Mixed support can be added later if users ask.
  const fullRegex = tryParseRegex(trimmed);
  if (fullRegex) {
    return { operators: [], freeText: '', regex: fullRegex, raw };
  }

  const tokens = tokenise(trimmed);
  const operators: OperatorFilter[] = [];
  const freeTextParts: string[] = [];

  for (const tok of tokens) {
    const op = tryParseOperator(tok);
    if (op) {
      operators.push(op);
      continue;
    }
    freeTextParts.push(tok);
  }

  return {
    operators,
    // Never trimmed or re-spaced: ` - ` trimmed to `-` would match (and a
    // Replace All rewrite) every hyphenated word, and two spaces would leave
    // nothing to find.
    freeText: operators.length === 0 ? raw : freeTextParts.join(' '),
    regex: null,
    raw,
  };
}

/**
 * True when the parsed query carries no actionable content. The Search
 * panel uses this to decide whether to clear results vs run a query.
 */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.operators.length === 0 && q.freeText === '' && q.regex === null;
}
