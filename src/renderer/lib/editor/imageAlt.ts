/**
 * An image's alt text keeps the characters its backslash escapes and
 * entities stand for.
 *
 * markdown-it builds an image's alt from its label's tokens and skips every
 * token it doesn't know as text, among them the `text_special` tokens an
 * escape (`\[`) or an entity (`&amp;`) makes. Its own `text_join` rule turns
 * those into text, but only at the top of an inline run, never inside an
 * image's label. So `![Aria \[sketch\]](x.png)` read as "Aria sketch". The
 * writer escapes `[`, `]` and `*` in alt text, so every save lost them, with
 * nothing flagged: both sides rendered alike. CommonMark reads an escape in
 * alt text as its character, as this rule makes markdown-it do.
 */

/** The slice of a markdown-it inline token the rule reads. */
interface InlineToken {
  type: string;
  children: InlineToken[] | null;
}

/** The slice of markdown-it the rule is registered on. */
interface CoreRulerHost {
  core: {
    ruler: {
      after(afterName: string, ruleName: string, fn: (state: { tokens: InlineToken[] }) => void): void;
    };
  };
}

/** Turns the escape and entity tokens inside `tokens`' images into text, at any depth. */
function joinImageText(tokens: readonly InlineToken[], inImage: boolean): void {
  for (const token of tokens) {
    if (inImage && token.type === 'text_special') token.type = 'text';
    if (token.children) joinImageText(token.children, inImage || token.type === 'image');
  }
}

/** The core rule: every inline run's images. */
function imageAltTextRule(state: { tokens: InlineToken[] }): void {
  for (const token of state.tokens) {
    if (token.type === 'inline' && token.children) joinImageText(token.children, false);
  }
}

/** Markdown-it instances already given the rule (tiptap-markdown calls `setup` on every parse). */
const prepared = new WeakSet<object>();

/** Registers {@link imageAltTextRule} on `md`, once. */
export function keepEscapedCharactersInImageAlt(md: CoreRulerHost): void {
  if (prepared.has(md)) return;
  prepared.add(md);
  md.core.ruler.after('text_join', 'filo-image-alt-text', imageAltTextRule);
}
