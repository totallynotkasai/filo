# UI Feedback 3: implementation plan (2026-09-26)

This plan comes from the first dogfooding test run after UI Feedback 2. It covers:
line spacing, the default font, the Project Settings dialog (layout plus a bug sweep),
and the blank flash on first board open.

It is small enough to ship as five work items instead of phases. Each item is its own
commit and must pass `npm run ci:verify` before the next one starts.

Order: **1 → 2 → 3 → 4 → 5**. Item 2 changes the settings dialog that item 3 adds a
field to, and the settings bugs have the most data-loss risk.

## Decisions already made

| Question | Answer |
|---|---|
| Line spacing control | A wider dropdown (a `<select>`) that shows the current number. It sits directly left of the indent buttons. |
| Line spacing default | A setting in Project Settings. Each note can override it from the toolbar. |
| Default font | **Arial Rounded MT** (Regular), with Arial Rounded MT Bold used for bold text. |
| Where the font applies | Everywhere: the interface and note text. There is no separate UI font. |
| Existing vaults | No legacy support needed. Changing the default is enough, and a vault that still stores `Inter` may simply be switched. |
| Settings dialog width | 900px. |
| Apply / Cancel placement | An action bar pinned at the **top** of the Global Defaults and Current Board tabs. The red "Apply … to all Boards" buttons stay at the **bottom**. |
| Cancel label | Renamed to **Revert**, because it discards pending changes without closing the dialog. |
| Blank flash on first board open | Explained and accepted. Item 5 is a small optional polish. |

---

## Item 1: Settings dialog bug sweep

A review of the Project Settings code found the bugs below. The two most serious
(1a, 1d) were confirmed against the code: `applyGlobal` replaces the whole of
`project.settings` with a copy taken when the dialog opened (`pendingSettings.svelte.ts:229-236`).

### 1a. HIGH: Apply on Global Defaults reverts changes made elsewhere in the dialog

`startGlobal` clones **all** of `project.settings` when the dialog opens. Meanwhile three
things write straight to the live settings:

- the General tab (font, UI size, hover buttons, board font sizes, imported fonts);
- a theme pick, which also resets every default colour;
- every colour pick, which adds to recent colours.

When Apply then runs `project.settings = deepClone(pending)`, all of those changes are
quietly put back. "Apply Current Global Defaults to all Boards" goes through the same path,
so it has the same problem.

**Fix:** the global pending copy holds only `settings.defaults`, the slice the Global Defaults
tab edits. `applyGlobal` writes that slice back and leaves `general`, the theme and
`recentColors` untouched. A theme change also refreshes the pending copy (only when it
has no edits; if it has edits, ask first), so the Global Defaults tab and LivePreview
show the theme's colours.

**Tests:** change General → Apply Global Defaults → the General change survives. Pick a theme →
Apply → the theme colours survive. Pick a colour → Apply → recent colours survive.

### 1b. HIGH: an out-of-range number on Current Board can make the board unloadable

`lib/settings/currentBoardHelpers.ts:48-49` checks only `Number.isFinite`. The inputs'
`min`/`max` attributes don't block a typed value. Border width 50 is saved, and the board
then fails `BoardFileDataSchema` on its next load.

**Fix:** clamp every numeric board setting to the schema's own range before it reaches the
pending copy. Read the bounds from the Zod schema, not from copied constants. Also validate
the whole pending board settings with the schema in `applyBoard`, and refuse (with a message)
rather than write something that won't load.

### 1c. HIGH: Global Defaults accepts NaN and out-of-range values

`BoardDefaults.svelte` uses a bare `parseInt` / `parseFloat` (around lines 105, 158, 184, 252,
324, 347 and 384). An empty field becomes `NaN`, which is saved as `null` in `defaults.json`. On
the next launch `parseSettingsSlices` rejects the slice and resets all of that board type's
defaults to factory values.

**Fix:** one shared `numberInput(value, { min, max, fallback })` helper, used by both tabs
(1b and 1c). An invalid entry snaps the field back to its last good value. `applyGlobal` also
checks the slice against the schema before writing.

### 1d. HIGH: "Apply … Defaults to all Boards" wipes each board's non-style settings

`buildBoardSettingsFromGlobal` replaces the whole `settings` block, so every board loses
Kanban saved views, its default folder, Mind Map snap/semantic zoom/connections and labels
visibility, and Task List group/sort. The confirm text promises only that *style* settings
will be overwritten.

**Fix:** merge only the style fields (`defaults`, colours, fonts) into each board's settings
and keep everything else. Also check whether "all Boards" misses boards that aren't in the
cache (`boardCache.svelte.ts:537` skips them). If it does, load them first or say which were
skipped.

### 1e. MED: the "Apply … to all Boards" buttons leave the other tab's pending copy stale

- "Apply Theme Defaults to all Boards" (`ProjectSettings.svelte:98-100`) doesn't re-arm
  Current Board, so a later Apply there writes the old settings back.
- "Apply Current Global Defaults to all Boards" (`:87`) calls `start()`, which throws away
  unsaved Current Board edits. The file's own comment warns against exactly this.

**Fix:** after either bulk action, re-arm only the active board's copy. If that copy has
unsaved edits, ask first (Apply them / Discard them / Cancel).

### 1f. MED: "Discard settings changes?" appears when nothing is unsaved

This follows from 1a, because the stale global copy differs from the live settings after
any General tab, theme or colour change. Separately, `setNestedField` leaves an empty `{}`
behind when an override is cleared back to Inherit, and that counts as a change.

**Fix:** 1a fixes the first cause. For the second, the dirty check prunes empty objects before
comparing, and clearing an override deletes its key.

### 1g. LOW: Apply / Revert are always enabled, and Apply always says "applied"

**Fix:** enable them only when that tab has unsaved changes. Disable them only while *this*
dialog's own save is running, not on the global `saveState` (any unrelated write makes that
flicker). Apply with nothing to save does nothing.

### 1h. LOW: a rejected General number stays in the field

For example `GeneralSettings.svelte:379-381`: a value of 25 is ignored but stays on screen, so
the user thinks it was saved. **Fix:** the shared helper from 1c snaps the field back.

### 1i. LOW: the default settings have drifted apart in three places

The schema (`schema/settings.ts`), the seed (`configOps.ts:103-116`) and the fallback in
`GeneralSettings.svelte:10-45` should match but don't. The seed lacks `taskItemBody`,
`taskSectionTitle` and `historyLimit`.

**Fix:** the seed and the fallback both come from `ProjectSettingsSchema.parse({})` (or a
shared `defaultProjectSettings()` in `src/shared/`, if the main process can't import the
renderer schema), so there is one list. This also matters for item 3, which changes a default.

### 1j. LOW: tab accessibility

Each tab gets an `id` and `aria-controls`, and the panel gets `aria-labelledby`. The Auto/Apply
chip is `aria-hidden`, with its meaning in the tab's `title`, so the tab isn't announced as
"General Auto".

### 1k. Check: can the active board change while the dialog is open?

If it can, `pendingBoardId` stays on the old board while LivePreview shows the new one. Check
whether any shortcut reaches the tab bar behind the modal. If one does, close the Current Board
session, or block board switching while the dialog is open.

### Item 1: done (2026-09-26). Deviations from the plan

- **1a, the slice.** There is no `settings.defaults` key. The Global Defaults tab edits
  `settings.mindmap / kanban / tasklist / document` (what `defaults.json` holds), so the
  pending copy is those four keys (`GLOBAL_DEFAULTS_KEYS` in `pendingSettings.svelte.ts`).
  `effective` lays them over the live settings, so LivePreview still sees `general`.
- **1a, the theme.** "Ask first" is the same Apply them / Discard them / Cancel prompt as 1e
  (`lib/settings/unappliedEditsPrompt.ts`), shown before a built-in theme is applied. The copy
  is taken again after the theme in every case, including when the theme fails to apply.
- **1b / 1c / 1h, the helper.** It is `lib/settings/numberInput.ts`: `numberBoundsAt(schema,
  path)` reads min / max / int from the Zod schema (walking optional / default / prefault),
  `numberInput(raw, bounds, fallback)` parses and clamps, and `readNumberField(input, bounds,
  lastGood, optional)` also writes the result back into the field. The shape differs from the
  planned `numberInput(value, { min, max, fallback })` because the bounds come from the schema.
  Each board type's settings schema is now exported as `boardSettingsSchemaFor(type)`. The
  clamping happens in the field, and both applies also validate against the schema and
  refuse with a toast, keeping the edit. The range sliders are unchanged, because the browser
  already keeps them in range.
- **1d.** The style keys are `backgroundColor`, `backgroundPattern`, `accentColor`,
  `titleFontSize` and `defaults` (`BOARD_STYLE_SETTING_KEYS`, `mergeBoardStyleSettings`).
  Boards not in the cache *were* skipped. Now both bulk actions `await
  boardCacheStore.ensureAllLoaded()` first, and any board that still can't be loaded is named in a
  warning toast. Both methods are now async and return `{ updated, skipped }`. The confirm text
  now says only style settings are overwritten.
- **1e.** The prompt comes *before* the bulk action, not after it, because it can't be asked
  partway through. The Current Board copy is taken again after the action. "Apply Current
  Global Defaults" still applies unapplied Global Defaults edits first (it uses the live
  defaults), then takes that copy again.
- **1g.** The button is still labelled **Cancel**. The rename to **Revert** belongs with the
  Item 2 action bar. The bulk buttons are also disabled while this dialog's own save runs.
- **1i.** Main can't import the renderer schema, so the one list is
  `src/shared/generalSettingsDefaults.ts`. `GeneralSettingsSchema`'s `.default()`s read it, the
  `app.json` seed is a copy of it (it now includes `historyLimit`, `taskItemBody` and
  `taskSectionTitle`), and the General tab falls back to `defaultProjectSettings().general`. A
  test checks that `GeneralSettingsSchema.parse({})` equals the list and that a new vault's
  `app.json` does too. The `appearance.json` seed font also comes from it.
- **1k: yes, it could.** The global shortcut listener is on `window`, so with focus on a
  button or select in the dialog, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+W switched or closed tabs
  behind it. Clicks can't reach the tab bar, because `showModal` makes the rest of the page inert.
  Fix: `Modal` has a new `isolateShortcuts` prop, set on the Settings dialog. It stops
  modifier keydowns (Ctrl / Meta / Alt) from bubbling to `window`, and default actions still run.
  As a backstop, if the active board changes anyway (for example, another program deletes
  the board file and its tab closes), the Current Board session starts again on the new board.
  Unapplied edits are dropped with a warning toast rather than applied to a board the user
  isn't looking at. Side effect: other modifier shortcuts, such as Ctrl+S, don't fire while
  focus is inside the Settings dialog.
- **Tests added:** `pendingSettingsSlices`, `settingsNumberInput` (it also checks that every
  number-field path the settings components name exists in its schema),
  `generalSettingsDefaults` and `applyDefaultsToAllBoards` (unit); `projectSettingsDialog` and
  `modalIsolateShortcuts` (component).
- **Found on the way, not fixed here:** the characterisation test *Tags browser popup › a tag
  with no board open shows its files* is flaky. It failed 1 of 3 runs, because
  `fileTagsStore.getFilesWithTag` lists files in vault-index load order. This is not related to
  Settings, so it is filed as a separate task.
- **Checks:** `npm run ci:verify` passes, including all 68 gates. The one flake above was the
  only failure on the first run. Real app (scratch vault, Playwright `_electron`): General font
  size 25 snaps to 20. On Global Defaults, Apply is disabled until an edit; 50 snaps to 10;
  blank goes back to the last value; after Apply, `app.json` still has the General change (20)
  and `defaults.json` has the new border (4). On Current Board, 50 snaps to 10, the board file
  saves 10 and loads again, and Ctrl+Tab no longer switches the tab behind the dialog.
  Closing with nothing unsaved asks nothing. There were no console errors.
- `GeneralSettings.svelte` and `ThemeManager.svelte` had CRLF endings in the working copy,
  though the repo stores LF (`.gitattributes eol=lf`). They are saved as LF again.

---

## Item 2: Settings dialog layout

1. **Width:** 900px (`AppShell.svelte:575`, `width="900px"`). Keep `width: 90%` so a small
   window still fits. Raise `max-height` from 80vh to 85vh.
2. **Only the page scrolls:** give `.settings-container` a fixed height inside the modal body
   (flex column, `min-height: 0` down the chain), so `.settings-panel` scrolls on its own and
   the tab rail stays put. Remove the modal body's padding for this dialog only (a
   `bodyClass` / `flush` prop on `Modal.svelte`), so the scrollbar sits at the edge.
3. **Action bar pinned at the top** of the Global Defaults and Current Board tabs, above
   LivePreview, outside the scrolling area:
   - left: "Unsaved changes" (or "No changes") in muted text;
   - right: **Revert** and **Apply**, enabled per 1g.
4. **Bulk actions at the bottom:** "Apply Current Global Defaults to all Boards" and "Apply
   Theme Defaults to all Boards" move to the end of the Global Defaults page, under a
   "Danger zone" heading, inside the scrolling area.
5. Fix the comment at `ProjectSettings.svelte:24-27` so it describes the real layout.

**Check:** a component test (the action bar is outside the scroll container, and the buttons
are disabled when nothing changed), the `components` gate group, and a real-app screenshot at
900×600 and at a normal window size.

### Item 2: done (2026-09-26). Deviations from the plan

- **Modal props.** `Modal.svelte` got two props rather than one: `maxHeight` (default `80vh`;
  the Settings dialog passes `85vh`, so other dialogs keep 80vh) and `flush`. `flush` removes the
  body's padding and scrolling and makes the body a shrinking flex column.
- **"Fixed height".** `.settings-container` is `height: 680px` with `min-height: 0`. Because the
  modal body is a shrinking flex column, in a short window the container shrinks to fit (447px at
  900×600) and the page scrolls instead of the dialog. The old `min-height: 420px` is gone,
  because it would have stopped that shrink.
- **Tab panel.** The `role="tabpanel"` element is now the right-hand column (`.settings-body`).
  It holds the action bar and the scrolling page (`.settings-scroll`), so the bar is still
  inside its tab's panel for assistive tech.
- **Action bar component.** It is `components/settings/SettingsActionBar.svelte` (props `dirty`,
  `busy`, `onApply`, `onRevert`). The "Unsaved changes" / "No changes" text is a
  `role="status"`, so a screen reader hears it change. ProjectSettings is 463 lines, well under
  the limit, so the split is for tidiness rather than size.
- **Danger zone.** It has a one-line hint under the heading ("These overwrite the style settings
  of every board and can't be undone.").
- **Found on the way and fixed:**
  - Once the tabs shared one scroll area, switching tabs kept the previous tab's scroll
    position (General opened scrolled 1454px down). The page is now `{#key activeTab}`, so each
    tab opens at its top. One side effect: LivePreview remounts when switching between Global
    Defaults and Current Board. It holds no state of its own, so this is harmless.
  - The rail was sized to its content, so the active tab's heavier label moved the page 3px
    when switching tabs. The rail now has a fixed width of 210px.
  - Stale "Apply/Cancel" / "modal-level footer" comments in `BoardDefaults.svelte` and
    `CurrentBoardMindMap.svelte` now say Apply / Revert and point at the dialog's bar.
- **Tests:** `projectSettingsDialog` now uses the action bar and Revert. It also checks that the
  bar is outside and before the scroll area, that the Danger zone is last on the page with both
  bulk buttons, that the status text changes with an edit, and that a tab opens at its top.
- **Checks:** `npm run ci:verify` passes (602 test files), including all 68 gates. On an earlier run, the known
  flaky `tagFilters` spec (see Item 1) failed once. It passed when run alone. Real app (scratch
  vault, Playwright `_electron`): at 1440×900 the dialog is 900px wide and the container is
  680px high. At 900×600 it shrinks to 781×510, within 85vh. In both, the modal body never
  scrolls, the rail stays in place, and the bar stays at the top while the page scrolls to the
  Danger zone. An edit turns the bar to "Unsaved changes" with Revert / Apply enabled. Revert
  restores the value and leaves the dialog open. There were no console errors.

---

## Item 3: Line spacing

### 3a. Toolbar control

- Replace the icon button and its popover (`TextFormattingToolbar.svelte:272-307`) with a
  labelled `<select>`, styled like the Heading and Align selects, about 72px wide. Options:
  - `Default (1.5)`, which shows the value it currently resolves to;
  - `1.0`, `1.15`, `1.5`, `1.75`, `2.0`, `2.5`, `3.0`.
  Update `LINE_SPACING_CHOICES` in `noteMeta.ts:78`; every value must be inside the valid
  0.8–4 range.
- Keep the line-spacing icon as a small leading glyph inside the control, so it stays
  recognisable.
- **Move it** to just before "Decrease Indent" (currently `:321`), in the same group as the
  indent buttons, i.e. after the list buttons' divider.
- Disabled state: keep it visible, with the tooltip "Click inside a note to set line spacing".
- Choosing a value still goes through `tiptapToolbar.setLineSpacing` → `SetLineSpacingCommand`
  (undoable, frontmatter `lineSpacing:`).

### 3b. Project default

- New setting `settings.general.defaultLineSpacing`, a number from 0.8 to 4, default **1.5**.
  The field is added to the schema, and the item 1i shared defaults cover the seed.
- **Settings → General**, next to Global Font: a "Default line spacing" select with the same
  choices. General is an Auto tab, so it applies at once, like the font.
- **Resolution:** the note's own `lineSpacing:` first, otherwise the project default. One helper,
  `resolveLineSpacing(path)` in `noteMeta.ts`, used by both views.
- **Document tab:** `DocumentEditor.svelte:373` sets `--note-line-height` to the resolved value
  always, and the 1.75 fallback at `:498` goes. (Documents move from 1.75 to 1.5 unless you
  change the default.)
- **Text tile:** `TextTile.svelte:60` uses the resolved value always, so a note has the same
  spacing in both views. Tiles currently inherit about 1.4–1.5 from board CSS.

**Tests:** resolution order (note > project > schema default), the toolbar label reflecting the
default, the `toolbarFormattingRoundTrip` save → reload case, and the settings schema default.

---

## Item 4: Default font, Arial Rounded MT

The font files are installed:

- **Arial Rounded MT** (Regular), per-user:
  `%LOCALAPPDATA%\Microsoft\Windows\Fonts\Arial Rounded MT Regular.ttf`;
- **Arial Rounded MT Bold**, system: `C:\Windows\Fonts\ARLRDBD.TTF`.

Windows registers them as **two separate family names**. With a CSS stack naming only the
Regular family, bold text would be synthesised (faux bold) instead of using the real Bold file.

### 4a. One family for both weights

Add a global `@font-face` pair in `src/css/style.css` that joins them under one name, using
`local()`. It loads nothing from disk by path and needs no CSP change; still confirm that under
the app CSP (`font-src 'self' data:`):

```css
@font-face { font-family: 'Filo Rounded'; font-weight: 400; src: local('Arial Rounded MT'), local('ArialRoundedMT'); }
@font-face { font-family: 'Filo Rounded'; font-weight: 700; src: local('Arial Rounded MT Bold'), local('ArialRoundedMTBold'); }
```

If `local()` doesn't match the per-user install in Electron, fall back to naming the families
directly, `'Arial Rounded MT', 'Arial Rounded MT Bold'`, and accept faux bold for weight 700.

### 4b. Make it the default

- `globalFont` default → `"'Filo Rounded', 'Arial Rounded MT', Arial, system-ui, sans-serif"`
  (`schema/settings.ts:234`, plus the seed and fallback via item 1i). Arial covers a machine
  without the font.
- `--font-system` in `style.css:66` gets the same stack, so the first paint before settings
  load doesn't flash in Segoe UI.
- Put "Arial Rounded MT" at the top of the `systemFonts` default list, and remove `Inter`
  (it isn't bundled, so it only ever rendered as a fallback).
- Your vault: set Global Font to Arial Rounded MT through Settings once item 4c lists it. No
  migration code.

### 4c. Bugs found on the way

1. **The font pickers only list 18 hard-coded fonts** (`fonts.ipc.ts:21-44`), so installed
   fonts such as Arial Rounded MT never appear. Fix: add Arial Rounded MT to the fixed list.
   Listing every installed font was considered and declined.
2. **The toolbar font box always says "Inter"** when the selection has no font mark
   (`toolbarConfig.ts:89`, `toolbar.svelte.ts:13,87`). It should show the effective global font
   name.
3. **Imported fonts disappear after a restart.** `new FontFace` / `document.fonts.add` runs only
   in the import handler (`GeneralSettings.svelte:253-272`). On vault open, register every font
   in `.filo/fonts/` (read through IPC as bytes, as the import does), and drop any on vault swap.
4. **The Global Font picker writes `"<font>, system-ui, sans-serif"`** (`GeneralSettings.svelte:360`),
   which leaves the Arial fallback out of the stack. Keep one helper that builds the stack for
   any chosen font.

**Check:** a settings default test, a font-stack helper test, the imported-font re-registration
test (mock IPC), and a real-app screenshot of the sidebar, a note and a Kanban board showing the
rounded font with real bold.

---

## Item 5 (optional polish): blank flash on first board open

The explanation was accepted. This is only worth doing if the flash still bothers you in a
packaged build.

- Once the vault has opened and the app is idle (`requestIdleCallback`, about 1s after open),
  call each `boardRegistry` loader, so every board type's code is already loaded when first
  opened.
- In dev, add the TipTap extensions to `optimizeDeps.include` in `electron.vite.config.mts`.
- If a load still takes over 150ms, show "Loading board…" instead of the empty
  `.board-loading` area.

---

## Verification (every item)

- `npm run ci:verify`: lint, svelte-check, typecheck:main, test:unit:strict, build, gates.
  In particular: the `components` group for the new timers and focus trap, `codebase` for file
  sizes (ProjectSettings and BoardDefaults must not cross 1000 lines; split the action bar into
  its own component if needed).
- A check in the real app, using the Playwright recipe from UI Feedback 1, with screenshots.
- `git diff --stat` before each commit, for CRLF flips.
