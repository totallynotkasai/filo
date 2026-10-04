# Track B investigation: the note editor, formatting in the file, and libraries

**Date:** 2026-10-02 · **Code:** `main` at `29b96ee` · **Status:** investigation only. Nothing in the app changed.

**Since (2026-10-04):** §6's "take now" updates, the TipTap tidy-up and the four "worth having" tools are done, by [archive/LIBRARY_UPDATES_PLAN_2026-10-02.md](archive/LIBRARY_UPDATES_PLAN_2026-10-02.md); §6 says what changed from what is written here. Track B itself (B1a–B1d), the Markdown profile and the decisions in §8 are still open.

**What was asked**
1. Are Track B1 and B2 ([BACKLOG.md](BACKLOG.md) §3) better for Filo in the long run?
2. How can their shortfalls, rich formatting first, be overcome in a logical, standard way? Notes don't have to open 1:1 in Obsidian, but their *content* must stay the same there even where the formatting doesn't. In Filo, formatting must be exact.
3. Which libraries and frameworks can be updated, and which would help finish Filo?

**How it was investigated**
- Read the editor pipeline (`src/renderer/lib/editor/`), `tiptap-markdown`'s source, the Audit-27 plan and review, KNOWN_LIMITATIONS #17 and #32, the design doc and the 2026-09-23 dependency report.
- Ran five throwaway probes against Filo's real editor in the unit-test environment, then deleted them. Their outputs are in Appendix A.
- Checked the npm registry on 2026-10-02, and had two research agents check upstream projects and docs (sources in Appendix B).
- Counted formatting markup in the vaults on this machine (read-only, counts only).

## How to read the scores

Every score is out of 10, as in the backlog:
- **Useful** (improvements): 0/10 = no gain; 5/10 = a clear improvement you'd notice every week or so; 10/10 = essential.
- **Hard**: 0/10 = minutes; 5/10 = a few days, several files, new tests; 10/10 = weeks, rewriting a major part of Filo.
- **Risk** (added for this report): what a mistake that got past the tests could do to your notes. 0/10 = can't touch a note file; 5/10 = could re-spell some notes on their next save (nothing lost: the round-trip check opens such a note read-only first); 10/10 = could lose text.
- **Impact** (bugs found on the way): 0/10 = harmless; 5/10 = a real annoyance, or a small change lost now and then; 10/10 = loses or corrupts notes.

---

## 1. The short answers

### B1 (write notes without `tiptap-markdown`): yes, better in the long run, but re-scope it

- **Keep the way notes are read.** Today Markdown is turned into HTML and the editor reads that HTML with its own rules. That is the path that reads underline, colour, highlight, font and size back in. The plan's token-by-token parser would have to rebuild exactly that part, the part you rely on most, for no gain.
- **Use the ownership to save only what you changed.** Every block you didn't touch is copied from the file byte for byte; only edited blocks are written by Filo. A 60-line prototype did this on Filo's real editor (Appendix A.3). One word added to a note written in Obsidian's style rewrote **7 of its 7 blocks today**, and **1 of 7 with the prototype**, and the result read back as the same note.
- **Then raw blocks (#17).** The few blocks Filo can't reproduce (an HTML comment, a reference link definition…) load as protected blocks saved exactly as written, so the rest of the note stays editable. Today one such block makes the whole note read-only.
- Together these give most of what B2 promised, with no risk to formatting.
- **Do the first stage (B1a) soon.** `tiptap-markdown`'s author now tells users to switch to TipTap's own Markdown package and doesn't plan to address issues. TipTap's own package, going by its source code, drops colour, font, size, alignment and indent when it saves (§3.4). So Filo has to own this code either way, and the first stage is a byte-identical move.
- Others have built the same idea on the same stack: GitLab's editor (TipTap) keeps the Markdown of blocks you didn't touch, and Stack Overflow's (ProseMirror + markdown-it) keeps raw HTML as protected blocks (§3.5).

### B2 (a CodeMirror source editor): no, not for Filo. Close it rather than keep it shelved

- It would keep every note byte-exact. But Filo's formatting (font, size, colour, highlight, underline, alignment, indent) would become tags in the text that the editor must hide, paint, split and merge on every toolbar click: a second rich-text engine built on top of a text editor.
- No source editor checked offers this. Obsidian has never had font, size or colour controls of its own (plug-ins that add them write HTML tags into the note), and none of the other CodeMirror-based editors checked has them either.
- Spell check, one of your must-haves, is unproven there: an Electron bug report says its spell checker doesn't mark CodeMirror text (§4.3).
- After B1's stages, what B2 would still add is small (the spelling *inside* the block you are editing). You write your notes in Filo, so that gain is small for you.
- CodeMirror does have one good, safe use in Filo: the **Raw view**, today a plain text box.

### Rich formatting: write the file format down as a standard, a "Filo Markdown profile"

- **One written form per formatting**, chosen from the most widely understood syntax that can hold it: Markdown first, then widely supported extensions, then HTML inside Markdown (which the Markdown standard itself allows), then frontmatter for whole-note settings. Every form keeps the words as plain text, so other apps always show the content even where they don't show the formatting.
- **Filo reads generously and writes strictly.** It accepts other spellings of the same formatting and writes only the documented one. Tests pin each form, and a second, independent Markdown parser (in the tests only) checks that the text reads the same outside Filo.
- **Two changes are worth making while your vaults hold no formatted notes yet** (none on this machine do):
  - colours written as you picked them, `#e03e3e`, not `rgb(224, 62, 62)`;
  - alignment and indent written as an HTML wrapper *around* ordinary Markdown, so a centred heading is still a heading and its links and tags still work in other apps. A prototype of this loaded and saved byte for byte (Appendix A.2).
- **Today only Filo's exact spellings read back.** A note holding `<span style="color: #e03e3e">`, which is how people and Obsidian plug-ins write a colour, opens read-only in Filo (Appendix A.4).

### Libraries and frameworks

- **Take now:**
  - DOMPurify 3.4.16 (it fixes the one `npm audit` finding, which is low);
  - Electron 44.5.1 (security fixes);
  - TipTap 3.31.4, on its own branch with the round-trip suites;
  - Vitest 5.0.3;
  - jsdom 30 (its focus and blur fixes matter for Filo's commit-on-blur tests).

  Also swap ten TipTap packages that are now one-line re-exports for the four they point at.
- **Wait, with a date or trigger:**
  - Electron 45 (stable 2026-10-20; Electron 44 is supported until 2027-03-02);
  - TypeScript 7 (no compiler API until 7.1, planned for 2026-11-24, and the Svelte and ESLint tools need one);
  - Vite 8 (electron-vite 6 is still beta);
  - markdown-it 15 (both `tiptap-markdown` and `prosemirror-markdown` require 14);
  - yaml 3 (pre-release).
- **New, worth having:**
  - CodeMirror 6 for the Raw view;
  - a second Markdown parser (micromark), in the tests only, to check content reads the same outside Filo;
  - Vitest's browser mode for editor tests in real Chromium;
  - knip to find dead code.
- **Not recommended:**
  - TipTap's own Markdown package;
  - a replacement editor framework;
  - anything that needs the network at run time or a native module.

### Recommended order

See §7 for the steps with scores and pass tests. In short: take the safe updates now; settle the profile decisions (§8) now; do B1a (own the glue, byte-identical) soon; then the profile's writer and reader, B1b + B1c (save only what changed), B1d (raw blocks), and the CodeMirror Raw view when convenient. Close B2.

---

## 2. How a note is read and written today

### 2.1 In plain terms

Filo's editor (TipTap, built on ProseMirror) does not edit the Markdown text. It reads the file into a structured document (paragraphs, headings, lists, and runs of text that each carry their formatting), lets you edit that, and on every save writes the **whole note** back out as Markdown. Reading and writing go through `tiptap-markdown`, a small community add-on, plus about twenty Filo modules that correct what it writes. After every load, Filo writes the note out in memory and compares: if a save would change what the note says, the note opens read-only.

```
Load:  file → frontmatter split → body
         → markdown-it renders the body as HTML
         → TipTap reads that HTML with each extension's rules → the editor's document
         → written out again in memory and compared: same meaning = editable, otherwise read-only

Save:  the editor's document → prosemirror-markdown's writer + Filo's writers + HTML for formatting
         → minimal escapes → note writer (fresh read, frontmatter patch, stat check) → file
```

### 2.2 What `tiptap-markdown` still does for Filo

| Job | How it does it | Already replaced by Filo? |
|---|---|---|
| Read Markdown into the editor | markdown-it renders HTML; small DOM tidy-ups; TipTap reads the HTML. It re-runs every extension's set-up on **every** parse, so Filo has to guard its markdown-it rules against being added twice. | No. Filo adds rules through its hooks (soft breaks, checklists, leading spaces, code fences, tabs, spaces). |
| The writer's engine | its own subclass of prosemirror-markdown's state, with a delimiter "tidy" | Yes (`delimiterRuns.ts`): prosemirror-markdown's own state |
| Writers for each kind of block and mark | defaults for about 20 node and mark types | Mostly: Filo replaced 14 (paragraph, heading, both lists, checklists, table, code block, both line breaks, quote, text, tab, leading space, link) |
| Writing formatting Markdown has no syntax for: underline, colour, font, size, highlight | a generic fallback: it renders the mark around a single space and cuts the HTML tags out with a regular expression | **No. Every formatting you rely on is written by this fallback** |
| Tight and loose lists | a list attribute | Partly: Filo replaced its reading rule (`taskListTight.ts`) |
| Copy and paste | its clipboard extension | Switched off; Filo's own `pastePlainText.ts` |
| The markdown-it version | its own dependency, `^14.1.0` | Shared with Filo's 14.3.2 today; blocks markdown-it 15 (§6) |

### 2.3 How each formatting you use is stored today

From probe A.1, on Filo's real editor. "HTML" means HTML inside the Markdown file, which the Markdown standard (CommonMark) allows.

| What you do in Filo | What the file holds today | Kind |
|---|---|---|
| Heading 1 to 6 | `## Title` | Markdown |
| Bold, italic, strikethrough | `**bold**`, `*italic*`, `~~struck~~` | Markdown (strikethrough: GFM) |
| Underline | `<u>text</u>` | HTML |
| Text colour (picked `#e03e3e`) | `<span style="color: rgb(224, 62, 62);">text</span>` | HTML |
| Highlight (picked `#ffe066`) | `<mark data-color="#ffe066" style="background-color: rgb(255, 224, 102); color: inherit;">text</mark>` | HTML |
| Font | `<span style="font-family: Georgia;">text</span>` | HTML |
| Font size | `<span style="font-size: 20px;">text</span>` | HTML |
| Colour, font, size and bold together | `<span style="color: rgb(224, 62, 62); font-family: Georgia; font-size: 20px;">**text**</span>` | HTML around Markdown |
| Centre, right, justify | the whole paragraph as one HTML line: `<p style="text-align: center;">Alpha <strong>beta</strong></p>` | HTML block |
| Centred heading | `<h2 style="text-align: center;">Title</h2>` | HTML block |
| Indent | `<p style="margin-left: 48px;">…</p>` | HTML block |
| Line spacing | `lineSpacing: 1.5` in the frontmatter | YAML |
| Bulleted, numbered, checklist | `- item`, `1. item`, `- [ ] task` | Markdown (checklists: GFM) |
| Link | `[text](https://example.com)` | Markdown |
| Clear formatting | removes the above | — |
| Spell check | nothing in the file: Electron's spell checker, with suggestions and "Add to dictionary" on right-click (`src/main/main.ts`) | — |

### 2.4 What is weak about it today

Each of these was checked on the real editor (Appendix A).

| # | What | Evidence | Matters for |
|---|---|---|---|
| W1 | **Colours are saved in a form you didn't pick.** `#e03e3e` is written as `rgb(224, 62, 62)`. The bytes come from the browser engine's style serialiser, not from Filo, so the file format depends on the engine. Checked in Chromium 152, the engine of Filo's Electron 44: it gives the same `rgb(…)` as the tests. | A.1 | Standards, readability, future Electron upgrades |
| W2 | **Only Filo's exact spellings read back.** `<span style="color: #e03e3e">`, `<span style="color: red">` (no final `;`), `<mark style="background-color: #ffe066">`, `<font color>`, `<sub>`, `<sup>`, `<ins>`: each opens the note read-only. These are the forms people write by hand and the popular Obsidian colour plug-ins write (Editing Toolbar: `<font color="#hex">`, `<mark style="background:#hex">`; Colored Text: `<span style="color:#hex">`), so a note coloured in Obsidian opens read-only in Filo. | A.4 | Notes from other apps |
| W3 | **A coloured highlight writes its colour twice**, plus `color: inherit`. | A.1 | Readability |
| W4 | **Alignment and indent turn the whole block into HTML.** The formatting inside becomes HTML (`<strong>`, `<a href>`); a centred heading is no longer a Markdown heading, so other apps' outlines skip it; `[[wiki links]]` and `#tags` inside it don't work in Obsidian. | A.1, A.2 | Content in other apps |
| W5 | **Lists can't be aligned** (decision D2 in `listItemLayout.ts`): an aligned list item as an HTML line swallowed its sub-items. | code | A missing feature |
| W6 | **Nested spans from another app keep only one style.** `<span style="color: blue"><span style="font-size: 18px">…` is saved as the size alone, because one run of text holds one style mark; the round-trip check therefore opens such a note read-only. | fixture `inline-html-spans`, in the corpus test's read-only set | Notes from other apps |
| W7 | **`==highlight==`** (Obsidian, Typora and others) loads as plain text with the equals signs. | A.1 | Notes from other apps |
| W8 | **Search reads the file's text**, so a phrase across formatting isn't found (`**bold** text` doesn't match "bold text"; a coloured word adds about 45 characters of tags), and searching `style`, `color` or `span` finds the tags. | `runSearch.ts` | Everyday search |
| W9 | **Kanban card previews drop font sizes and indents.** The preview's sanitiser (`sanitizeHtml.ts`, `ALLOWED_STYLE_PROP`) keeps colour, font and alignment but not `font-size` or `margin-left`, so a card shows that text at the normal size until its editor mounts, then it jumps. Impact 2/10, Hard 1/10. | A.5 | A small bug (not in the backlog) |

W1, W2, W6 and W9 have one root cause: **three places decide which formatting exists** (the editor's reading rules, the writer, and the preview's sanitiser), and each spells it its own way.

### 2.5 Why fidelity work keeps coming back

- **Every save rewrites the whole note from the editor's model.** A writer that spells one kind of block differently changes that block in every note on its next save, including blocks you never touched. KNOWN_LIMITATIONS #17's "restyle on first edit" table is the visible part of this.
- **The fidelity layer is large and still growing:** 22 modules, about 3,300 lines (about 1,900 lines of code), guarded by about 2,300 lines of round-trip suites, a property test and an 18,870-note corpus run.
- **It takes a large share of the work:** 43 of the 177 commits since 2026-09-01 changed `lib/editor/`. Whole audit phases were about notes Filo couldn't read back ("editor writes that broke Markdown", "notes that opened read-only for no stated reason", "soft line breaks and minimal escapes").
- **372 of the 18,870 corpus notes still open read-only** (Audit-26), almost all because of one block: an HTML comment, a `<div>`, a reference link definition, code inside bold.

---

## 3. B1: own the Markdown pipeline, re-scoped

### 3.1 What the backlog plan says, and what I'd change

The Audit-27 plan's B1: drive markdown-it and prosemirror-markdown directly (markdown-it tokens → ProseMirror nodes; Filo's writers registered with prosemirror-markdown), drop `tiptap-markdown`, and prove it with the corpus (0 changed, 0 newly lossy), the property sweep (14 seeds × 1,500) and every round-trip suite.

Three changes:
1. **Don't build a token-by-token parser.** Underline, colour, highlight, font and size arrive in a note as HTML tags. A token parser sees each opening and closing tag as a separate token and would have to pair them up, track nesting, and cope with broken HTML: in effect, rebuild the browser's HTML parser plus TipTap's reading rules for the formatting you rely on most. The current route (markdown-it → HTML → TipTap's rules) already does this, and the corpus proves it. Keep it, and own it.
2. **Read block by block, so Filo knows where each block came from.** That is what makes the next change possible.
3. **Save only what changed, then add raw blocks.** These are the stages that pay back, and they cover B2's main gains.

### 3.2 The stages

**B1a: take ownership of the glue (byte-identical).** Useful 6/10, Hard 4/10, Risk 2/10.
- Move the parts of `tiptap-markdown` Filo still uses into `lib/editor/`. That is about 600 lines of its source (the glue plus the default writers Filo hasn't replaced), and less once the parts Filo already replaced or switched off are left out:
  - one markdown-it factory, shared by the editor, the card preview, the round-trip check and paste (today the preview and paste build their own);
  - the read step (render, Filo's DOM hooks, read into the editor's document);
  - the writer registry, with explicit writers for underline, text style (colour, font, size) and highlight in place of the regular-expression fallback. In this stage they still write today's exact bytes.
- Load a note by handing the editor a parsed document, instead of overriding TipTap's `setContent` command. `markdownSync.ts` is already the one place that loads a note.
- Remove the `tiptap-markdown` dependency.
- **Pass test, all required:** the corpus (18,870 notes) with 0 changed bytes and 0 changed read-only verdicts; the property sweep; every round-trip suite unchanged; the E2E editor-fidelity spec.
- **Gains:** one fewer little-maintained package on the write path; one markdown-it version and set-up for the whole app (needed for markdown-it 15, §6); set-up runs once per editor, not on every parse; a typed, documented writer interface.

**B1b + B1c: save only what you changed.** Useful 7/10, Hard 5/10, Risk 3/10.
- **B1b, read block by block:** parse the body once, split the top-level tokens into blocks (markdown-it gives each one's line range), read each block on its own, and keep a side record per loaded editor: block → its lines in the file → the editor nodes it became. Text no block covers (a reference link definition renders nothing) is recorded too. No change to the document schema.
- **B1c, the save:** match today's top-level blocks to the loaded ones. ProseMirror keeps an untouched block as the very same object between edits, and its `eq` test still matches it after an undo (probe A.1: identity `[same, changed, same, same]` after typing in block 2; `eq` true for every block after undo). Copy each unchanged block from the file as it was, and the gap before it when its neighbour is unchanged too; write only changed or new blocks.
- **Verify before writing:** read the result back with the same parser. If it isn't the same document as the editor's, use today's whole-note writing for that save. A mistake in the new path can therefore only cost the old behaviour, never a change to the note.
- **Prototype (A.3):** a note in Obsidian / Keep spelling (Setext heading, `_italic_`, `__bold__`, `*` bullets, `1)` numbers, a two-space line break, a `***` rule). One word typed at the end of its last paragraph: today's save re-spells **all 7 blocks**; the prototype writes **1 of 7** and copies the other 6, and the result reads back as the same document.
- **Gains:**
  - the restyle-on-first-edit table (#17) shrinks to "the block you edited";
  - a diff of the note (git, or a sync tool's conflict copy) shows only what you changed;
  - a writer mistake can only reach the blocks you edit, so the next fidelity bug has a much smaller blast radius;
  - undoing an edit puts the file's own bytes back.
- **Details the plan must settle:** matching when blocks are added, deleted or moved (align by `eq`); the empty-paragraph blank lines (`emptyParagraphs.ts` already works from the same line ranges); adjacent lists, where a new list must take the other bullet from the copied one (the verify step catches a slip); CRLF (anchor on the LF body; the note writer re-applies line endings, as now); several views of one note (each anchors to the body it loaded, as each already reloads from the model).

**B1d: raw blocks (#17).** Useful 7/10, Hard 6/10, Risk 3/10.
- A block whose own round trip would change what it says (an HTML comment or `<div>`, a reference link definition, code inside bold, nested spans from another app) loads as a protected **raw block**: shown rendered, like a card preview, saved exactly as written, editable through a small source box, and deletable like any other block. The rest of the note stays editable.
- The read-only state remains only for notes that aren't UTF-8 and for symbolic links. Take ownership is rarely needed.
- **Gain:** the 372 corpus notes that open read-only today become editable around their raw blocks.

### 3.3 Why B1 is better in the long run

1. **The dependency.** `tiptap-markdown` 0.9.0 was published on 2025-09-08, with no release since. Its README now says: *"please prefer using the official extension over this package. I don't plan to address current issues / PR."* It has 22 issues and 3 pull requests open. Filo already holds every TipTap upgrade behind its round-trip suites because of it (KNOWN_LIMITATIONS #32). If a TipTap update breaks it, nobody upstream will fix it, and Filo would be stuck on an older TipTap, security fixes included.
2. **The parser version is held back.** `tiptap-markdown` asks for markdown-it `^14.1.0`, and so does `prosemirror-markdown` (`^14.0.0`); markdown-it 15 is out. Moving Filo's own markdown-it to 15 today would leave the editor on 14 and the preview on 15: two parsers for one format. Filo already forbids that for YAML (gate `no-jsyaml`). B1a removes the first of the two blockers; the second is prosemirror-markdown's own release (§6.3).
3. **A smaller blast radius** (B1c), which also makes every later editor change cheaper to verify.
4. **The base for #17**, the backlog's most useful editor item (Useful 7/10).
5. **No risk to formatting.** B1a passes only if every corpus note writes the same bytes; B1c falls back to today's writing whenever its result doesn't read back as the editor's document.

**Against it:** about three to four weeks of work across the stages, which could go to features instead; more code Filo owns (though Filo already effectively owns this code, given how much of it it patches).

**When:** B1a whenever convenient, and sooner rather than later. It is byte-identical by its own pass test, and it removes a package whose author has stepped back. The later stages are important but not urgent: start them after some weeks of daily use, as the plan says.

### 3.4 What about TipTap's own Markdown package?

TipTap has published an official `@tiptap/markdown` since TipTap 3.7.0 (2025-10-14). It is now 3.31.4, versioned with TipTap, and its documentation calls it "a early release" that "may have edge cases that may not be supported yet". From its source:
- **It parses with `marked`, not markdown-it.** Each TipTap extension turns `marked` tokens into the document (`parseMarkdown`) and writes itself back (`renderMarkdown`). The installed TipTap 3.31 extensions already carry these hooks; its Paragraph writes a second empty paragraph as `&nbsp;` (Filo writes an extra blank line).
- **It drops the formatting you use.** Text style (colour, font, size) and alignment have no Markdown writer, and a mark or attribute without one is written as nothing, so all of them disappear on save. Underline is written `++text++`, which no common app reads; highlight is written `==text==` without its colour.
- **It reads inline HTML, then loses it.** `<span style="color: red">` becomes a colour mark when the note loads, and the save drops it.
- **It escapes freely.** Every `\`, `` ` ``, `*`, `_`, `[`, `]` and `~` in text is escaped, `_` inside words included, so other apps' notes change on their first save.
- **Open bugs include one that loses text:** #8395, where a paragraph such as "Hi. there" is read as a numbered list and "Hi" is deleted (reported on 3.31.3). 22 open issues have "markdown" in the title.

**Verdict: not a target for B1, and not a fallback either.** It would lose most of the formatting you require, and Filo's whole fidelity system (the round-trip check, the card preview, paste, soft breaks, `rendersSame`) rests on markdown-it. Worth a look once a year.

### 3.5 Others have built this, on the same stack

- **GitLab's rich-text editor** (TipTap on ProseMirror, like Filo) set out in 2021 to "retain original markdown for all blocks that were not touched by the user", writing only edited blocks. The first attempt was abandoned because its parser's source positions were inaccurate. It was redone in 2024 on accurate positions from GitLab's own parser, behind a feature flag, also keeping each mark's delimiter and the reference definitions. How much of it is switched on today is unverified.
- **Stack Overflow's editor** (ProseMirror with markdown-it, like Filo) keeps raw HTML as uneditable blocks, which is B1d's raw block. It also remembers each node's original syntax (a `markup` attribute), so it writes `_` back as `_`.
- **VS Code's experimental Markdown editor** (2026) keeps the source as the document and shows the block you are in as source: a B2-style design (§4.4).

Two lessons for B1c:
1. **Block positions must be exact.** markdown-it's line ranges are exact for top-level blocks, which is all B1c uses, and the prototype relied on them.
2. **A wrong position must not be able to hurt.** Verify-before-write does that: a mismatch costs one save in today's spelling, never a change to what the note says.

**An optional extra, B1e: keep your spelling inside an edited block too.** Stack Overflow's idea applied to Filo: remember, per block and per mark, which spelling the file used (`_` or `*`, `+` or `-` bullets, a Setext heading) and write it back that way. It narrows B2's last advantage (§4.5). Useful 3/10, Hard 4/10, Risk 2/10. Only worth it if notes from other apps become common in your vaults.

---

## 4. B2: a source editor (CodeMirror 6), assessed

### 4.1 In plain terms

CodeMirror edits the text of the file itself. Formatting is shown by styling that text and hiding its symbols until the caret reaches them (Obsidian's Live Preview). Whatever you don't touch stays exactly as it was, by construction.

### 4.2 What it would gain

- Every note byte-exact, including the spelling inside the block you edit.
- No read-only notes.
- Most of the 22 fidelity modules (about 1,900 lines of code) could go.
- Very large notes stay fast (CodeMirror draws only what is on screen).

### 4.3 What it would cost: your formatting

"Hard" here is the work to reach today's behaviour in a source editor.

| You need | Today (ProseMirror) | In a CodeMirror source editor | Hard |
|---|---|---|---|
| Headings, bold, italic, lists, checklists, links | a structured document; toolbar toggles | Markdown symbols styled and hidden away from the caret (Obsidian does this) | 5/10 |
| Underline, text colour, highlight colour, font, size | marks on the text, in any mix; what you type next takes the formatting at the caret | HTML tags in the text. The editor must hide them, paint the style, wrap, split and merge tags for every toolbar command, and decide on which side of a hidden tag your typing lands: **a second rich-text engine on top of text** | 8/10 |
| Alignment, indent | block attributes | marker lines hidden, lines styled | 6/10 |
| Line spacing | frontmatter, applied as CSS | the same | 1/10 |
| Tables | TipTap's table editor, resizable | a table widget (Obsidian built its own) | 7/10 |
| Spell check | Electron's spell checker on the editor, with suggestions on right-click | **unproven**: Electron issue #53608 (Electron 44, Linux, closed "not planned") reports the built-in spell checker never marking CodeMirror 6 text. Obsidian, also Electron and CodeMirror, does offer spell check, so it can be made to work, but a spike would have to prove it on Windows first | 3/10 |
| Kanban cards, Mind Map tiles, card previews | one editor everywhere | every tile becomes a CodeMirror editor with the same hiding and painting | 5/10 |
| Paste from Word or the web | HTML read into the document | HTML converted into the profile's markup | 4/10 |

### 4.4 Could B2 carry formatting in a standard way?

Yes, as far as the **file** goes: it would write exactly the profile in §5, and CodeMirror would draw it. The format is not the obstacle. The **editing** is: while you edit coloured, sized or underlined text, a source editor either shows you the tags or has to act as if they weren't there.

The editors that went this way show the gap:
- **Obsidian** has no font, size or colour controls of its own. Plug-ins add them by writing HTML into the note (`<font color>`, `<span style="color: …">`, `<mark style="background: …">`, `<center>`). A long-open Obsidian bug report, confirmed by staff, says "Reader supports inline HTML but editor/live-preview does not" for spans that hold Markdown. Its 1.14 early-access release (September 2026) adds coloured highlights, written `==🔵text==`, in five colours: formatting arrives slowly there, and in Obsidian's own syntax.
- **VS Code's experimental Markdown editor** (published June 2026) keeps the source as the document, renders the blocks you are not in, and shows the block you are in as source. No colour or font formatting was found in it.
- **Gravity UI's markdown-editor** pairs a ProseMirror rich-text mode with a CodeMirror source mode; its colours are a non-standard `{red}(text)`, named colours only.

None of them offers what Filo's toolbar does today.

### 4.5 What B2 would still beat B1 at

After B1a–B1d, B2's remaining edge is:
- the spelling *inside* a block you edit (B1 writes that block in Filo's spelling, so `_italic_` becomes `*italic*` there);
- editing unusual syntax inline rather than in a raw block's source box;
- very large notes.

For notes you write in Filo, none of these comes up often.

### 4.6 Verdict

**Not better for Filo in the long run.** The plan's "Useful 9/10 for the full change" assumed byte-exactness and read-only notes were the main problems. B1c and B1d solve most of both, and B2 would put the formatting you use every day at risk.

| Option | Useful | Hard | Risk |
|---|---|---|---|
| B2, the full change, today | 3/10 | 9/10 | 7/10 |
| B2, the spike only | 1/10 | 5/10 | 0/10 |

Recommendation: close B2 and drop the spike. Revisit only if Filo's purpose changes to editing other apps' vaults in place, or if B1c or B1d fail their pass tests.

### 4.7 Where CodeMirror 6 does fit: the Raw view

The Raw view (`NoteRawView.svelte`) is a plain text box today. CodeMirror there would give Markdown colouring, line numbers, search inside the note, and a jump to the line the read-only banner names, with no risk to notes: the raw view already saves the whole file as typed (KNOWN_LIMITATIONS #30). Useful 4/10, Hard 3/10, Risk 1/10. It would load as a separate chunk only when the Raw view opens: about 79 KB gzipped for the core, and up to 175 KB more with Markdown highlighting (§6.5). The Raw view has spell check off already.

---

## 5. Formatting in the file: the standard way (a "Filo Markdown profile")

### 5.1 In plain terms

Every formatting Filo offers gets **exactly one written form**. It is chosen from the most widely understood syntax that can hold it, written down in one document, and checked by tests. Filo reads generously (other spellings of the same formatting) and writes strictly (only the written form). The words of a note always stay plain text in the file, so any app shows the content even where it can't show the formatting.

### 5.2 Principles

1. **Content is always text.** No words inside tag attributes or comments.
2. **One spelling per formatting**, so the same note always gives the same bytes and a diff shows only real changes.
3. **The most widely understood syntax wins**, in this order:
   1. CommonMark;
   2. GFM (tables, checklists, strikethrough);
   3. an extension that major apps render natively (only `==highlight==` qualifies);
   4. HTML inside Markdown, a fixed set of tags and style properties (CommonMark allows raw HTML; Obsidian, VS Code and Typora render it);
   5. frontmatter, for settings that cover the whole note (line spacing).
4. **Formatting must never break Markdown structure.** A heading stays a `#` heading, a list stays a list, a link stays `[text](url)`, whatever formatting they carry.
5. **Degrade to content, never to clutter.** In an app that ignores the formatting you see the words, at worst with tags around them; never words moved, merged or lost.
6. **Read generously, write strictly.** Other spellings of the same formatting read in as editable; Filo writes only the canonical form, and only into blocks you edit (once B1c exists).
7. **Written down and tested in one place.** One module defines the vocabulary (tags, style properties and their order); the reading rules, the writers, the preview's sanitiser and the round-trip comparison all use it.

### 5.3 The profile

| Formatting | Filo writes | Filo also reads | In Obsidian and other apps | Change from today |
|---|---|---|---|---|
| Headings | `## Title` | Setext (`Title` over `===`) | heading | none |
| Bold, italic, strikethrough | `**b**`, `*i*`, `~~s~~` | `__b__`, `_i_` | same | none |
| Underline | `<u>text</u>` | `<ins>`, `text-decoration: underline` | underlined in Obsidian (documented) and Typora | reads more spellings |
| Text colour | `<span style="color: #e03e3e">text</span>` | `rgb(…)`, colour names, any case, with or without `;`, `<font color>` | coloured in Obsidian's Reading view, Typora and VS Code's preview; plain text on GitHub, which strips styles | **hex as picked**, no `;` |
| Highlight, no colour of its own | `==text==` | `<mark>` | highlighted in Obsidian (its own syntax) and Typora (when switched on); text with the `==` on GitHub and in VS Code's preview | **new form** (decision 5) |
| Highlight in a colour | `<mark style="background-color: #ffe066">text</mark>` | `data-color`, `rgb(…)`, the `background:` shorthand, a `background-color` span | highlighted in its colour in Obsidian (its colour plug-ins write this form) and Typora; a plain highlight on GitHub | simpler |
| Font, size | `<span style="font-family: Georgia; font-size: 20px">` | any order, quoted names | the font if installed, and the size (Obsidian, Typora); plain text on GitHub | fixed order |
| Several at once | one span: `color`, `font-family`, `font-size`, in that order, around Markdown (`**bold**` inside) | nested spans, merged | as above | fixed order; nested spans read |
| Alignment, indent | an HTML wrapper with blank lines, Markdown inside (§5.4) | today's `<p style>` / `<h2 style>` lines, read forever; `<p align>` and `<center>` (what Obsidian's Editing Toolbar writes) | **every word and all the Markdown kept everywhere**; centred in VS Code's preview, not in Obsidian, Typora or GitHub | **new form** (decision 4) |
| Line spacing | `lineSpacing: 1.5` in the frontmatter | — | a property | none |
| Lists, checklists, links, tables, code | CommonMark / GFM | the usual variants | same | none |

### 5.4 Alignment and indent: the options

| Option | Example | In Filo | Elsewhere | Markdown inside kept? |
|---|---|---|---|---|
| **A. Today:** the block as one HTML line | `<p style="text-align: center;">Some <strong>bold</strong></p>` | works | should be centred in Obsidian's Reading view and Typora, as a complete HTML block (per their help; not tested here); GitHub strips the style. Inside it, wiki links and tags are plain text, and a centred heading isn't a heading, so it is missing from outlines | No |
| **B. HTML wrapper with blank lines** | see below | prototype loads, saves byte for byte, reloads the same (A.2) | every word and all the Markdown kept everywhere; centred in VS Code's preview, not in Obsidian, Typora or GitHub. The two wrapper lines may show as text in Obsidian's Live Preview (not tested here) | **Yes** |
| C. Attribute syntax (Pandoc, markdown-it-attrs) | `Some **bold** {style="text-align: center"}` | needs a plug-in | `{…}` shown as text in Obsidian, Typora, GitHub and VS Code, inside the paragraph and in heading outlines | Yes |
| D. An HTML comment before the block | `<!-- filo: align=center -->` | needs a reading rule | hidden in Obsidian's Reading view and on GitHub, shown as source in Obsidian's Live Preview; never aligned anywhere else | Yes |

**Recommended: B.** It is CommonMark's own way of putting HTML around Markdown: an HTML block ends at a blank line, so the Markdown between the opening and closing tags is read as Markdown. markdown-it renders it as a centred `<div>` holding a real heading and paragraph (A.2):

```markdown
<div style="text-align: center">

## Chapter One

Some **bold** text with a [link](https://example.com) and a #tag

</div>
```

- Consecutive blocks with the same alignment share one wrapper. Indent uses the same wrapper (`margin-left: 48px`); both together are one style.
- Reading needs a 15-line hook; writing needs about 30 lines (both prototyped in A.2).
- It also makes "align a whole list" possible later.
- The cost is four extra lines per aligned run in the file. If that proves too noisy, D is the fallback: no clutter, but no alignment anywhere outside Filo.
- **In Obsidian the trade-off is plain.** Today's form (A) should show centred, but the Markdown inside it is gone: wiki links and tags in it are plain text, and a centred heading drops out of the outline. The wrapper (B) keeps every word and all the Markdown (bold, links, tags and headings work), but Obsidian doesn't centre it: its help says HTML blocks can't contain blank lines, and it doesn't read Markdown inside HTML. That is exactly "the content the same, the formatting may differ", so B is the better fit. Typora behaves like Obsidian; GitHub strips the style either way.

### 5.5 Colours

- **Write the colour as picked**, lower-case hex: `#e03e3e`. Build the style text in Filo's writer, never through the browser's style serialiser, so the file format doesn't depend on Chromium (W1).
- **Read every common spelling** (hex in any case, `rgb()`, names, `<font color>`) as the same colour, and compare styles as property lists, not as text, in the round-trip check. A colour from another app then opens editable (W2).
- **Optional, later: colours that follow the theme.** A colour picked on Light can be hard to read on Dark, Blueprint, Retro or Nature. Palette colours could be written `color: var(--filo-red, #d32f2f)`: standard CSS, where Filo's themes define `--filo-red` and any other app falls back to `#d32f2f`. Useful 3/10, Hard 4/10. Decide after some weeks of daily use (decision 6).

### 5.6 Highlight

- `==text==` is the one formatting extension a major app reads natively: it is Obsidian's own highlight syntax, Typora reads it when switched on in its preferences, and markdown-it has a plug-in for it. GitHub and VS Code's preview show it as text with the equals signs.
- **Read it as a highlight** (today it shows as text with the equals signs).
- **Write it for a highlight with no colour of its own.** The toolbar always picks a colour today, so this needs one new swatch, first in the highlight picker: "Theme highlight", written `==text==`. It shows in the theme's own highlight colour, so it reads well on every theme, and Obsidian shows it natively. Filo already reads a colourless `<mark>` the same way.
- A highlight in a chosen colour stays `<mark style="background-color: #ffe066">`.
- A literal `==` you type in text must then be escaped where it would read as a highlight. The escaping modules already handle `*`, `_`, `[` and `~` the same way, and `=` is already on the round-trip check's watch list.
- **To watch: Obsidian's coloured highlights.** Obsidian 1.14, in early access since 2026-09-02, writes a coloured highlight as `==🔵text==` (a colour emoji after the `==`; five colours). If it reaches a public, documented release, Filo could read it, and write it for its matching palette colours so those highlights show in colour in Obsidian. Until then the emoji would be a stray character in every other app, so not yet.

### 5.7 What changes in your files, and when

- **Now is the cheapest time.** The vaults on this machine hold no formatted notes yet: Test Vault (the one Filo last opened) has 3 notes and 2 boards; the book vault has 13 notes; none holds a single colour span, highlight, aligned block or `lineSpacing` key.
- **Old forms are read forever.** Today's `rgb()` colours, `<mark data-color>` highlights and `<p style>` lines keep loading, editable.
- **No mass rewrite, ever.** Before B1c, a note takes the canonical forms on its next save, as today. After B1c, only the blocks you edit do.

### 5.8 Keeping it standard over time

- **A profile document**, `docs/FILO_MARKDOWN_PROFILE.md`, versioned: this section's table, with the exact spellings.
- **One vocabulary module** used by the reading rules, the writers, the preview's sanitiser (fixes W9) and the round-trip comparison (fixes W2).
- **Conformance fixtures**, one per row: what Filo writes, that it reads back to the same document, and that a second save writes the same bytes. They extend the existing golden corpus and the toolbar suite.
- **A second parser in the tests only.** Render each fixture with markdown-it and with the CommonMark reference parser (and/or micromark with GFM), and check that the **visible text is identical**: the content survives in any CommonMark app. This mirrors how js-yaml is kept as a test oracle for YAML.
- **A "one Markdown parser" gate**, like `no-jsyaml`: the app imports only markdown-it for Markdown; `marked`, `remark` and `micromark` only in tests.

---

## 6. Libraries and frameworks

Checked against the npm registry and release notes on 2026-10-02. The last full pass was 2026-09-23 ([archive/DEPENDENCY_UPGRADE_REPORT_2026-09-23.md](archive/DEPENDENCY_UPGRADE_REPORT_2026-09-23.md)). Since then the stack is close to current, so this is mostly patches, a few majors to time, and some tools worth adding. `npm audit`: 1 low advisory (DOMPurify, fixed in 3.4.16), nothing moderate or higher, production or dev.

**Done (2026-10-03 to 2026-10-04),** by the library updates plan ([archive/LIBRARY_UPDATES_PLAN_2026-10-02.md](archive/LIBRARY_UPDATES_PLAN_2026-10-02.md)); each phase's outcome there has the details:
- **§6.1, all of it** (Phases 1 and 2), with eslint 10.12.0 as well. jsdom ended at 30.1.2 (Phase 8).
- **§6.2** (Phase 3), with TipTap 3.31.4. The patch changed what Filo saves in five places; the one that mattered (tables saved as HTML opened read-only) is fixed in Filo, the other four were kept and pinned by tests.
- **§6.5's four "worth having" tools:** knip (Phase 4, run in `ci:verify`), micromark in the tests (Phase 5), Vitest's browser mode (Phase 6), CodeMirror 6 for the Raw view (Phase 7). Where it went differently from the table below, each row says so.
- **`npm audit`** found a new advisory in electron-builder's download chain on 2026-10-03 (GHSA-ch52-4w7c-c8xp, build time only). `http-cache-semantics` 4.3.0 fixed it on 2026-10-04, a lockfile-only change, so §6.3's electron-builder 27 is no longer needed for it. `npm audit`: 0.
- **Still waiting:** §6.3 and §6.4 as written.

### 6.1 Take now

| Package | Now | Take | Why | Useful | Hard | Risk |
|---|---|---|---|---|---|---|
| dompurify | 3.4.15 | 3.4.16 | Fixes the one `npm audit` finding (GHSA-p98j-92pf-mc4p, low). Filo's use can't trigger it (it sanitises strings, with only an attribute hook), but it is a free fix. | 2/10 | 1/10 | 1/10 |
| electron | 44.4.5 | 44.5.1 | Chromium, V8, ANGLE and Dawn security fixes. | 3/10 | 1/10 | 1/10 |
| `@tiptap/*` (24 packages) | 3.31.3 | 3.31.4 | Patch release. On its own branch with every round-trip suite, as KNOWN_LIMITATIONS #32 asks. | 2/10 | 1/10 | 2/10 |
| jsdom (tests) | 29.1.1 | 30.1.1 | 30.1.1 fixes spurious `blur` / `focusout` events and a wrong `relatedTarget` after the focused element is removed: what Filo's commit-on-blur tests depend on. Its only breaking change is the Node range, which local Node 24.16 and CI's Node 22.23 meet. | 3/10 | 2/10 | 1/10 |
| vitest, @vitest/coverage-v8 | 5.0.1 | 5.0.3 | Fixes. | 1/10 | 1/10 | 0/10 |
| typescript-eslint, globals, sharp | 8.70.1, 17.12, 0.35.4 | 8.71.0, 17.13, 0.35.5 | Fixes. | 1/10 | 1/10 | 0/10 |
| package.json floors | eslint ^10.4, @playwright/test ^1.60, yaml ^2.9.0 | ^10.11, ^1.63, ^2.9.1 | The lockfile already holds these; raising the floors stops a fresh install going back. yaml 2.9.1 limits recursive merge aliases. | 1/10 | 0/10 | 0/10 |
| electron-vite config | `externalizeDepsPlugin({ exclude: ['zod'] })` | `build.externalizeDeps: { exclude: ['zod'] }` | The plug-in is deprecated (already in electron-vite 5); this is one step of the Vite 8 move done early. | 1/10 | 1/10 | 1/10 |

### 6.2 A tidy-up: ten TipTap packages are now one-line re-exports

TipTap 3 moved several extensions into four packages. In `node_modules`, ten of Filo's direct dependencies are now re-export files of about 230 bytes each:
- `extension-color` and `extension-font-family` re-export `@tiptap/extension-text-style`, which also ships `FontSize`, `LineHeight` and `BackgroundColor`;
- `extension-bullet-list`, `extension-ordered-list`, `extension-task-item` and `extension-task-list` re-export `@tiptap/extension-list`;
- `extension-table-cell`, `extension-table-header` and `extension-table-row` re-export `@tiptap/extension-table`;
- `extension-placeholder` re-exports `@tiptap/extensions`.

Import from the four packages and drop the ten. Fewer packages to move in step at each TipTap upgrade. Useful 2/10, Hard 1/10, Risk 1/10 (imports only; the corpus must stay byte-identical).

### 6.3 Wait, and what to watch for

| Package | Now → latest | Why wait | Take it when | Useful | Hard | Risk |
|---|---|---|---|---|---|---|
| Electron 45 | 44 → 45 | Stable on 2026-10-20 (Chromium 156). Electron 44 is supported until 2027-03-02. | After 45.1, on its own branch, with the E2E suite on Windows. Electron 46 follows on 2027-01-05. | 3/10 | 2/10 | 2/10 |
| TypeScript 7 | 6.0.3 → 7.0.2 | The fast native compiler, but 7.0 has no compiler API. typescript-eslint (`<6.1.0`) can't use it at all; svelte-check only through a second package alias and its `--tsgo` flag, whose results may differ slightly. | TypeScript 7.1 (planned stable 2026-11-24, with an API) and typescript-eslint / svelte-check releases built on it. A hybrid (TS 7 only for `typecheck:main`) is possible earlier but not worth the setup. | 3/10 | 3/10 | 1/10 |
| Vite 8, vite-plugin-svelte 7 | 7.3.6 → 8.3.2 | Faster builds (Rolldown, Oxc), but electron-vite 6, which Vite 8 needs, is still beta (6.0.0-beta.5, no stable date). Vite 7.3 still gets fixes and security patches. | electron-vite 6 stable. Then `rollupOptions` → `rolldownOptions` and `manualChunks` → `codeSplitting` in `electron.vite.config.mts`. | 3/10 | 3/10 | 2/10 |
| markdown-it 15 | 14.3.2 → 15.0.2 | `tiptap-markdown` and `prosemirror-markdown` both require markdown-it 14, and prosemirror-markdown's types import a file 15 removed. Upgrading now would ship two parsers. Its changes for Filo are small: a few CommonMark fixes (a backslash before a space in a link address is kept; a named entity needs its `;`), and linkify changes Filo doesn't use (linkify is off). 15.0.0 shipped on 2026-07-30, and the 14 line still gets security fixes (14.3.1, 14.3.2), so waiting is safe. 15's new `reference_definition` tokens would help B1d. | After B1a, and once prosemirror-markdown accepts 15. Review the corpus diff line by line. | 2/10 | 2/10 | 3/10 |
| yaml 3 | 2.9.1 → 3.0.0-2 (pre-release) | ESM only, and API changes that reach the frontmatter engine (`Document.contents` becomes `.value`; the parser returns arrays). The maintainer says anything may still change. | A stable 3.0, on its own branch with the frontmatter-invariant suite. | 1/10 | 5/10 | 4/10 |
| electron-builder | 26.15.3 (26.17.0 on the `v26` tag) → 27 alpha | npm's `latest` tag is stuck at 26.15.3, so `^26.8.1` never reaches 26.17. 26.16–26.17 are mostly updater and packaging fixes Filo doesn't use. | Pin 26.17.0 only if a packaging fix is needed; wait for 27 stable. | 1/10 | 1/10 | 1/10 |

### 6.4 Skip

| Package | Why | Useful | Hard | Risk |
|---|---|---|---|---|
| js-yaml 5 (test oracle only) | New API (no default export, `safeLoad` gone) and a different default schema, so the oracle's meaning would shift. Version 4 is still patched. | 0/10 | 2/10 | 2/10 |
| nanoid 6 | Faster IDs Filo doesn't need; drops Node 18 and 20. Harmless if ever wanted. | 1/10 | 1/10 | 0/10 |

### 6.5 New libraries and tools that would help

| Library | What for | Status | Recommendation | Useful | Hard | Risk |
|---|---|---|---|---|---|---|
| CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-markdown`) | The Raw view (§4.7) | Active (view 6.43.13). About 79 KB gzipped for view + state; `lang-markdown` up to 175 KB more, as it pulls in HTML highlighting. | Own branch; load it as a lazy chunk, only when the Raw view opens. The Raw view has spell check off already, so the Electron issue about spell check in CodeMirror (§4.3) doesn't affect it. **Done (Phase 7)**, re-scored Hard 4/10. It uses `@lezer/markdown` instead of `@codemirror/lang-markdown`, which pulls in HTML, CSS and JavaScript support and changes the text itself (list continuation on Enter, a link made from a pasted address). The chunk is fetched only when a Raw view first opens. | 4/10 | 3/10 | 1/10 |
| micromark + micromark-extension-gfm (tests only) | The second parser of §5.8: checks the content reads the same outside Filo | micromark 4.0.3, active, "passes all tests from CommonMark" | Take with the profile work (step 4). **Done earlier (Phase 5)**, with the strikethrough, table and task-list extensions rather than the whole of `micromark-extension-gfm`. Gate `one-markdown-parser` keeps it out of the app. It found four ways a note Filo saves reads differently on GitHub (BL-15 to BL-18). | 4/10 | 2/10 | 0/10 |
| commonmark.js (tests only) | The CommonMark reference implementation, as a second oracle (no GFM) | 0.31.2, matching the current spec 0.31.2 | Optional, next to micromark. | 2/10 | 1/10 | 0/10 |
| Vitest browser mode (`@vitest/browser` with Playwright) | Editor tests in real Chromium: selection, layout and `contenteditable` as in the app, which jsdom only imitates | Stable since Vitest 4 | Own branch, as a fourth test project for editor tests, before B1b + B1c. (It runs Chromium, not Electron, so the E2E suite stays.) **Done (Phase 6)**, on `main`, with Playwright's headless shell only; it runs in `ci:verify`. | 4/10 | 3/10 | 0/10 |
| knip (dev only) | Finds unused files, exports and dependencies | 6.39.0, active | A report-only run on its own branch. ~~It needs Svelte's own compiler plugged in, or it reports components' exports as unused.~~ **Corrected by Phase 4:** no Filo component exports anything, and the compiler alone caused false positives, since it drops type-only imports (one file and several types read as unused). knip's built-in reader read a string as an import. Filo's `knip.ts` reads components with the compiler and adds the type-only imports back. **Done (Phase 4)**, on `main`; it runs in `ci:verify`, and 38 unused exports were removed. | 3/10 | 2/10 | 0/10 |
| virtua | Virtual lists (a large sidebar folder, KNOWN_LIMITATIONS #40; long search results) | 0.52.10, Svelte 5 support, still 0.x | Only if the scale budgets show a need; how it works with svelte-dnd-action is untested. | 2/10 | 3/10 | 1/10 |
| node-diff3 | A "Merge" choice in the note conflict prompt, when your edit and the outside change touch different lines | 3.2.1, no dependencies | Only if you want merging as a feature; a wrong automatic merge is worse than a prompt. | 2/10 | 4/10 | 4/10 |

### 6.6 Considered and not recommended

| Library | Why not | Useful | Hard | Risk |
|---|---|---|---|---|
| `@tiptap/markdown` | §3.4: drops colour, font, size, alignment and indent on save; a different parser (`marked`); an open bug that deletes text | 1/10 | 7/10 | 9/10 |
| Another editor framework (Milkdown, Lexical, BlockNote…) | Each replaces the editor wholesale. None offers Filo's formatting set with better Markdown fidelity than B1 would (§6.7) | 1/10 | 10/10 | 8/10 |
| `marked`, `remark` / `unified` in the app | A second Markdown parser reading notes (the "one parser" rule); tests only | 1/10 | 3/10 | 4/10 |
| dependency-cruiser | Import-boundary rules fit better as a small gate in `scripts/gates`, the house style | 2/10 | 2/10 | 0/10 |
| `@axe-core/playwright` | Calls `newPage`, which Electron refuses; keep the current manual axe injection | 1/10 | 2/10 | 0/10 |
| oxlint | Lints only the script part of `.svelte` files; type-aware rules need TypeScript 7 | 1/10 | 2/10 | 0/10 |
| `@tanstack/svelte-virtual` | Built on Svelte stores, against the runes-only rule | 1/10 | 3/10 | 1/10 |
| `electron-updater` | Checks for updates over the network, against the local-first rule | 1/10 | 4/10 | 2/10 |
| `@parcel/watcher`, chokidar | Filo's watcher is purpose-built (supervisor, reconcile walk, own-move records), and `@parcel/watcher` is a native module; Filo has none and should keep it so | 1/10 | 6/10 | 5/10 |

### 6.7 Frameworks: what is worth adopting

- **Svelte** (5.57.1, current). Features added since 5.29 that suit Filo's style, to use when touching nearby code rather than as a project: `{@attach}` for DOM behaviour instead of actions (stable since 5.29), `createContext` for typed context (5.40), `SvelteMap.getOrInsert` (5.57). Leave `await` in markup alone: it stays experimental until Svelte 6. Useful 1/10, Hard 1/10, Risk 0/10.
- **Electron**: §6.3. No change to the spell checker, `webUtils`, `protocol.handle`, sandbox or context-isolation behaviour Filo relies on in 44.x or the 45 alphas.
- **Other editor frameworks** were checked for comparison; none would serve Filo better, and none keeps untouched blocks as they were:
  - Milkdown 7.22 (ProseMirror with remark) makes no fidelity claim, and its 2026 issues include backslashes doubling on every round trip;
  - Lexical 0.52's Markdown support needs a custom transformer for each format Markdown lacks;
  - BlockNote 0.55 names its export `blocksToMarkdownLossy`;
  - Plate writes formatting as MDX, which is not CommonMark (no HTML comments; `<` and `{` must be escaped);
  - Novel is inactive and runs on `tiptap-markdown`.
- **ProseMirror has moved off GitHub.** Since 2026-04-01 its repositories, prosemirror-markdown included, live at code.haverbeke.berlin. Releases continue on npm (prosemirror-markdown 1.13.8 on 2026-09-21); read changelogs and file issues there.
- **The design doc is out of date here:** its "Markdown Processing" line still lists `unified`, `remark-parse` and `remark-frontmatter` for the vault index. None of them is installed, and CLAUDE.md says the index doesn't parse Markdown. The Editor section still lists the separate TipTap packages and `tiptap-markdown`. Update both lines when B1a lands. *Done earlier, by the library updates plan:* Phase 3 rewrote the Editor section's package list, and Phase 8 (BL-19) the VaultIndex paragraph and the Markdown, search and testing lines. Only the `tiptap-markdown` line waits for B1a.

---

## 7. Proposed order, with pass tests

| # | Step | Useful | Hard | Risk | Pass test |
|---|---|---|---|---|---|
| 1 | Safe updates (§6.1) and the TipTap package tidy-up (§6.2). **Done** (library updates plan, Phases 1–3) | 3/10 | 1/10 | 1/10 | `ci:verify` on Windows; for TipTap, every round-trip suite on its own branch (KNOWN_LIMITATIONS #32) |
| 2 | Owner decisions on the profile (§8) | 5/10 | 1/10 | 0/10 | — |
| 3 | B1a: own the glue, byte-identical (§3.2) | 6/10 | 4/10 | 2/10 | corpus 0 changed bytes and verdicts; property sweep; all suites; E2E editor fidelity |
| 4 | Profile part 1: one vocabulary module, deterministic writers (hex colours, fixed order), generous reading, the preview sanitiser fix (W1, W2, W3, W6, W9) | 5/10 | 3/10 | 2/10 | conformance fixtures; corpus diff reviewed line by line (only colour and highlight spellings may change); notes that become editable listed |
| 5 | markdown-it 15, once prosemirror-markdown accepts it (§6.3) | 2/10 | 2/10 | 3/10 | corpus diff reviewed; property sweep |
| 6 | B1b + B1c: save only what you changed (§3.2) | 7/10 | 5/10 | 3/10 | corpus: open, edit one block, save: only that block differs; verify-before-write counted in tests; all suites |
| 7 | B1d: raw blocks (#17) | 7/10 | 6/10 | 3/10 | the 372 read-only corpus notes open editable, and untouched they save byte for byte |
| 8 | Profile part 2: alignment wrapper, `==` highlight (decisions 4 and 5) | 4/10 | 3/10 | 2/10 | conformance fixtures; second-parser text check |
| 9 | CodeMirror 6 for the Raw view (§4.7). **Done** (library updates plan, Phase 7) | 4/10 | 3/10 | 1/10 | the raw view's existing component tests; E2E |
| 10 | Search on the visible text (W8): match the words, map back to the file | 4/10 | 4/10 | 1/10 | search and Replace suites; Replace still never touches tags |
| — | B2 | 3/10 | 9/10 | 7/10 | not planned |

Steps 3 to 8 are Track B. Each step leaves a working app, runs `npm run ci:verify` on Windows and the E2E suite, and is committed on its own, as in earlier plans. Each would get its own plan from [BACKLOG.md](BACKLOG.md) when it starts.

---

## 8. Decisions for the owner

| # | Question | My default |
|---|---|---|
| 1 | Re-scope B1: keep the HTML reading route, then "save only what changed", then raw blocks | Yes |
| 2 | Close B2 and drop the spike; CodeMirror only for the Raw view | Yes |
| 3 | Colours written as picked (`#e03e3e`), read in any common spelling | Yes |
| 4 | Alignment and indent as an HTML wrapper around ordinary Markdown (option B), old form read forever | Yes, in step 8 |
| 5 | `==text==` read as a highlight, and written for a new "Theme highlight" swatch (no colour of its own) | Yes, in step 8 |
| 6 | Theme-following palette colours (`var(--filo-red, #d32f2f)`) | Not now; decide after some weeks of daily use |
| 7 | Add W9 (card previews drop font sizes and indents) to the backlog as BL-11 (that number has since gone to another item; W9 would take the next free one) | Yes |

---

## Appendix A. Probe results

All probes ran in the unit-test environment (Vitest, jsdom) against `createTiptapEditor` and `markdownSync.ts`, and were deleted afterwards. The outputs below are verbatim. The colour spelling was also checked in Chromium 152 (the engine of Electron 44): setting `#e03e3e` as a colour gives the style `color: rgb(224, 62, 62);`, and `#ffe066` as a background gives `background-color: rgb(255, 224, 102);`, the same as jsdom.

### A.1 Today's file forms

Start: `Alpha beta gamma [[Wiki Link]] #tag`, the first block selected, then one command.

```
underline                     <u>Alpha beta gamma [[Wiki Link]] #tag</u>
text colour (#e03e3e)         <span style="color: rgb(224, 62, 62);">Alpha beta gamma [[Wiki Link]] #tag</span>
highlight (#ffe066)           <mark data-color="#ffe066" style="background-color: rgb(255, 224, 102); color: inherit;">…</mark>
highlight (no colour)         <mark>Alpha beta gamma [[Wiki Link]] #tag</mark>
font family                   <span style="font-family: Georgia;">…</span>
font size                     <span style="font-size: 20px;">…</span>
colour + size + font + bold   <span style="color: rgb(224, 62, 62); font-family: Georgia; font-size: 20px;">**Alpha beta gamma [[Wiki Link]] #tag**</span>
centre                        <p style="text-align: center;">Alpha beta gamma [[Wiki Link]] #tag</p>
centre + colour on one word   <p style="text-align: center;">Alpha <span style="color: rgb(224, 62, 62);"><strong>beta</strong></span> gamma [[Wiki Link]] #tag</p>
indent twice                  <p style="margin-left: 48px;">Alpha beta gamma [[Wiki Link]] #tag</p>
heading 2 + centre            <h2 style="text-align: center;">Alpha beta gamma [[Wiki Link]] #tag</h2>
```

How other spellings load today:

```
Alpha ==beta== gamma                                      editable; shown as text "==beta=="
<div style="text-align: center"> + Markdown + </div>      read-only (the wrapper is dropped)
<!-- filo: align=center --> + paragraph                   read-only (the comment is dropped)
Alpha [beta]{style="color: red"} gamma                    editable; shown as text
<p align="center">Alpha</p>                               read-only
```

ProseMirror keeps untouched blocks (four top-level blocks; same object as at load?):

```
after typing in block 2:           [same, changed, same, same]
after bold in block 4:             [same, changed, same, changed]
after undoing both, eq() to load:  [true, true, true, true]
markdown-it line ranges:           paragraph 0-1, paragraph 2-3, bullet_list 4-7, paragraph 7-8
```

### A.2 The alignment wrapper, prototyped

A 15-line reading hook (a `<div style>` hands its alignment to the blocks inside, then goes) and a 30-line writer (runs of blocks with the same layout go in one wrapper, written as Markdown).

```
Source and wrapper save (identical, byte for byte):

Intro line

<div style="text-align: center">

## Title

Some **bold** [link](https://x.y) text #tag

</div>

Outro **line**

Loaded as:   paragraph · heading 2 (centred) · paragraph (centred) · paragraph
Reload of the save gives the same document: true

Today's writer for the same document:

<h2 style="text-align: center;">Title</h2>

<p style="text-align: center;">Some <strong>bold</strong> <a href="https://x.y">link</a> text #tag</p>

markdown-it renders the wrapper as:
<div style="text-align: center">
<h2>Title</h2>
<p>Some <strong>bold</strong> <a href="https://x.y">link</a> text</p>
</div>

A paragraph centred and indented in the editor, wrapper writer:
<div style="text-align: center; margin-left: 24px">

Second with **bold**

</div>
```

### A.3 Saving only what changed, prototyped

A note in another app's spelling; one word (` EDITED`) typed at the end of the last paragraph.

```
Loads editable: true · blocks 7, editor nodes 7

Today's save (every block re-spelled)      Prototype (only the edited block written)
# Setext Title                             Setext Title
                                           ============
Some *italic* and **bold** words.          Some _italic_ and __bold__ words.
- first                                    * first
- second                                   * second
1. one                                     1) one
2. two                                     2) two
A line with a two-space break\             A line with a two-space break··
next line                                  next line
---                                        ***
Last paragraph to edit. EDITED             Last paragraph to edit. EDITED

Blocks copied from the file: [yes, yes, yes, yes, yes, yes, no]
Verify (the save reads back as the edited document): true
```

(`··` marks the two trailing spaces; blank lines between blocks are left out here.)

### A.4 Colour and formatting spellings from other apps

```
<span style="color: #e03e3e">red</span>                 read-only   would save: <span style="color: rgb(224, 62, 62);">
<span style="color:#E03E3E">red</span>                  read-only   (same)
<span style="color: rgb(224, 62, 62);">red</span>       editable    (Filo's own spelling)
<span style="color: red">red</span>                     read-only   would save: <span style="color: red;">
<font color="red">red</font>                            read-only   would save: red (colour dropped)
<mark style="background-color: #ffe066">marked</mark>   read-only   would save: <mark data-color="#ffe066" style="…rgb(255, 224, 102); color: inherit;">
<mark>marked</mark>                                     editable
<span style="background-color: #ffe066">marked</span>   read-only   would save: <span>marked</span>
<span style="font-weight: bold">heavy</span>            read-only   would save: <span>**heavy**</span>
<span style="text-decoration: underline">under</span>   read-only   would save: <span><u>under</u></span>
<ins>inserted</ins>                                     read-only   would save: inserted
<sub>low</sub> and <sup>high</sup>                      read-only   would save: low and high
<span style="font-size: 1.2em">em-sized</span>          read-only   would save: <span style="font-size: 1.2em;">
```

### A.5 Kanban card preview (`renderNotePreviewHtml`)

```
<span style="font-size: 20px;">big</span>                       → <span style="">big</span>
<span style="color: …; font-family: Georgia; font-size: 20px;">  → <span style="color: rgb(224, 62, 62); font-family: Georgia">
<p style="margin-left: 48px;">Indented twice.</p>               → <p style="">Indented twice.</p>
<p style="text-align: center;">Centred.</p>                     → <p style="text-align: center">Centred.</p>
```

---

## Appendix B. Sources

Upstream facts were checked on 2026-10-02. Where a source couldn't confirm something, the text says so ("unverified", "not tested here").

**This repository**
- `docs/BACKLOG.md` §3; `docs/archive/AUDIT27_IMPLEMENTATION_PLAN_2026-10-01.md` (Track B, decision D9); `docs/archive/AUDIT27_REVIEW_2026-10-01.md` (#17, #32); `docs/archive/AUDIT26_IMPLEMENTATION_PLAN_2026-09-30.md` (corpus figures); `docs/archive/DEPENDENCY_UPGRADE_REPORT_2026-09-23.md`; `KNOWN_LIMITATIONS.md` #17, #30, #32; `Filo_Design_Doc_Rework_V5.md` (Editor, Text Formatting, Markdown Processing).
- Code: `src/renderer/lib/editor/` (`createEditor.ts`, `markdownSync.ts`, `blockLayout.ts`, `listItemLayout.ts`, `delimiterRuns.ts`, `renderedSame.ts`, `staticPreview.ts`, `noteEditorView.ts`, `emptyParagraphs.ts`), `src/renderer/lib/utils/sanitizeHtml.ts`, `src/renderer/lib/search/runSearch.ts` and `markdownSyntax.ts`, `src/main/main.ts` (spell checker); tests `toolbarFormattingRoundTrip.test.ts` and `markdownBodyRoundTrip.test.ts` with its fixtures.
- Installed packages: `node_modules/tiptap-markdown/src`, `node_modules/prosemirror-markdown` (package.json, dist), `node_modules/@tiptap/*/dist`.
- `git log` since 2026-09-01; formatting-markup counts in `C:\Users\andre\My Files\Vaults\` (counts only).

**Registry:** npm, queried 2026-10-02 (`npm view`, `npm outdated`, `npm audit`).

**TipTap and tiptap-markdown**
- tiptap-markdown README (the maintenance notice): https://github.com/aguingand/tiptap-markdown
- Announcement: https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap
- Docs: https://tiptap.dev/docs/editor/markdown
- Source: https://github.com/ueberdosis/tiptap/blob/main/packages/markdown/src/MarkdownManager.ts, its `CHANGELOG.md`, `packages/extension-underline/src/underline.ts` and `packages/extension-highlight/src/highlight.ts`
- Issues: https://github.com/ueberdosis/tiptap/issues/8395 (text deleted), 8215, 8116, 8136, 8341, 8374, 8413, 8314, 8404

**markdown-it and prosemirror-markdown**
- https://github.com/markdown-it/markdown-it/blob/master/CHANGELOG.md and the v14 branch's CHANGELOG
- https://github.com/markdown-it/linkify-it/blob/master/CHANGELOG.md
- https://app.unpkg.com/prosemirror-markdown@1.13.8/files/CHANGELOG.md
- https://github.com/ProseMirror/prosemirror-markdown/blob/master/src/from_markdown.ts (now hosted at code.haverbeke.berlin)
- https://github.com/markdown-it/markdown-it-mark, https://github.com/revin/markdown-it-task-lists

**Obsidian and other apps**
- Obsidian help, HTML content: https://obsidian.md/help/Editing+and+formatting/HTML+content; syntax: https://obsidian.md/help/syntax
- Obsidian 1.14 (early access): https://obsidian.md/changelog/2026-09-02-desktop-v1.14.0/
- Obsidian forum: https://forum.obsidian.md/t/live-preview-support-inline-html-elements-like-span/62707, https://forum.obsidian.md/t/markdown-inside-raw-html-not-rendered-correctly/40569, https://forum.obsidian.md/t/multiple-lines-in-html-block-rendering-correctly-in-live-preview-but-not-in-render-mode/48587, https://forum.obsidian.md/t/css-differentiate-between-obsidian-and-html-comments/71893
- Obsidian plug-ins: https://github.com/PKM-er/obsidian-editing-toolbar, https://github.com/chetachiezikeuzor/Highlightr-Plugin, https://github.com/erincayaz/obsidian-colored-text
- Typora: https://support.typora.io/HTML/, https://support.typora.io/Markdown-Reference/
- GitHub: https://github.com/github/markup, https://github.com/gjtorikian/html-pipeline/blob/main/lib/html_pipeline/sanitization_filter.rb
- VS Code preview: https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/src/preview/documentRenderer.ts

**Standards**
- CommonMark 0.31.2 (HTML blocks, §4.6): https://spec.commonmark.org/
- Generic directives proposal: https://talk.commonmark.org/t/generic-directives-plugins-syntax/444
- Pandoc fenced divs and bracketed spans: https://pandoc.org/MANUAL.html#extension-fenced_divs
- Djot: https://djot.net/, https://github.com/jgm/djot.js
- markdown-it-attrs: https://github.com/arve0/markdown-it-attrs

**Prior art and other editors**
- GitLab: https://gitlab.com/gitlab-org/gitlab/-/merge_requests/68702, https://gitlab.com/gitlab-org/gitlab/-/issues/455457, https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/assets/javascripts/content_editor/services/markdown_source.js
- Stack Overflow: https://github.com/StackExchange/Stacks-Editor
- VS Code Markdown editor: https://www.npmjs.com/package/@vscode/markdown-editor
- Gravity UI: https://github.com/gravity-ui/markdown-editor
- Milkdown: https://github.com/Milkdown/milkdown/issues/2349; Lexical: https://lexical.dev/docs/packages/lexical-markdown; BlockNote: https://www.blocknotejs.org/docs/features/export/markdown; Plate: https://platejs.org/docs/markdown; MDX: https://mdxjs.com/docs/what-is-mdx/; Novel: https://github.com/steven-tey/novel

**Toolchain**
- TypeScript 7: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/, plan for 7.1: https://github.com/microsoft/TypeScript/issues/63703
- svelte-check: https://github.com/sveltejs/language-tools/releases, https://github.com/sveltejs/language-tools/issues/3063
- typescript-eslint: https://github.com/typescript-eslint/typescript-eslint/issues/10940, https://github.com/typescript-eslint/typescript-eslint/pull/12803
- Vite 8: https://vite.dev/blog/announcing-vite8, https://vite.dev/guide/migration, https://vite.dev/releases
- electron-vite 6: https://github.com/alex8088/electron-vite/blob/v6.0.0-beta.5/CHANGELOG.md, https://github.com/alex8088/electron-vite/issues/894
- vite-plugin-svelte: https://github.com/sveltejs/vite-plugin-svelte/blob/main/packages/vite-plugin-svelte/CHANGELOG.md
- Vitest 5 and browser mode: https://vitest.dev/blog/vitest-5.html, https://vitest.dev/guide/browser/
- Electron: https://releases.electronjs.org/schedule, https://www.electronjs.org/blog/electron-44-0, https://releases.electronjs.org/release/v44.5.1, https://github.com/electron/electron/issues/53608 (spell check in CodeMirror)
- Other packages: https://github.com/jsdom/jsdom/releases, https://github.com/ai/nanoid/blob/main/CHANGELOG.md, https://github.com/nodeca/js-yaml/blob/master/docs/migrate_v4_to_v5.md, https://github.com/eemeli/yaml/releases, https://github.com/electron-userland/electron-builder/releases, https://github.com/sveltejs/svelte/blob/main/packages/svelte/CHANGELOG.md
- Advisory: https://github.com/advisories/GHSA-p98j-92pf-mc4p
- Tools: https://knip.dev/features/compilers, https://github.com/sverweij/dependency-cruiser, https://github.com/bhousel/node-diff3, https://github.com/inokawa/virtua, https://github.com/TanStack/virtual/issues/866, https://github.com/dequelabs/axe-core-npm/issues/1141, https://oxc.rs/docs/guide/usage/linter.html, https://bundlephobia.com/package/@codemirror/lang-markdown@6.5.2, https://github.com/micromark/micromark
