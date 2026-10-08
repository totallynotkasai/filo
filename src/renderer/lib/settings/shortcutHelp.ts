/**
 * Help → Shortcuts: every key the app answers, by area.
 *
 * "Everywhere" holds the commands registered now that belong to no board.
 * Each board's part holds its commands (`constants/shortcutReference.ts`),
 * whether or not a board of that kind is open, with the key each has now (a
 * rebound one included), then the fixed keys of its rows or cards; "Text"
 * holds the editor's keys.
 *
 * A key may be rebound only where it can't collide: two boards may share a
 * key (each board's acts only while focus is in it), but a board command
 * can't take a key another command of its board or a command that works
 * everywhere has, and a command that works everywhere can't take any board's.
 */
import type { Shortcut, ShortcutBinding } from '../../core/hotkeys';
import { SHORTCUT_AREAS, type FixedKey } from '../../constants/shortcutReference';

export interface HelpCommand {
  /** The command id, or (for a shortcut registered without one) its description. */
  id: string;
  label: string;
  binding: ShortcutBinding;
  /** False for a shortcut registered without a command id: it can't be rebound. */
  rebindable: boolean;
}

export interface HelpSection {
  title: string;
  commands: HelpCommand[];
  fixed: readonly FixedKey[];
}

const EVERYWHERE = 'Everywhere';

/** The area a board command belongs to ("Kanban" …), or null for any other command. */
function areaOf(id: string): string | null {
  return SHORTCUT_AREAS.find((a) => a.commands.some((c) => c.id === id))?.title ?? null;
}

function bindingOf(s: ShortcutBinding): ShortcutBinding {
  return { key: s.key, ctrl: s.ctrl ?? false, shift: s.shift ?? false, alt: s.alt ?? false };
}

function sameBinding(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return a.key.toLowerCase() === b.key.toLowerCase()
    && Boolean(a.ctrl) === Boolean(b.ctrl)
    && Boolean(a.shift) === Boolean(b.shift)
    && Boolean(a.alt) === Boolean(b.alt);
}

/** The label under its area's heading: "Kanban: Add column" reads "Add column" under "Kanban". */
function shortLabel(label: string, area: string): string {
  return label.startsWith(`${area}: `) ? label.slice(area.length + 2) : label;
}

/** Every command Help knows, each once, with the key it has now. */
function allCommands(registered: readonly Shortcut[], overrides: Readonly<Record<string, ShortcutBinding>>): HelpCommand[] {
  const out: HelpCommand[] = [];
  const seen = new Set<string>();
  // A board shown in two split panes registers its commands once per pane.
  for (const s of registered) {
    const id = s.commandId ?? s.description;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: s.description, binding: bindingOf(s), rebindable: s.commandId !== undefined });
  }
  for (const area of SHORTCUT_AREAS) {
    for (const c of area.commands) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, label: c.label, binding: bindingOf(overrides[c.id] ?? c.binding), rebindable: true });
    }
  }
  return out;
}

/** Help's sections, "Everywhere" first, then each board's and the text's. */
export function helpSections(registered: readonly Shortcut[], overrides: Readonly<Record<string, ShortcutBinding>>): HelpSection[] {
  const commands = allCommands(registered, overrides);
  const everywhere: HelpSection = { title: EVERYWHERE, commands: commands.filter((c) => areaOf(c.id) === null), fixed: [] };
  const areas = SHORTCUT_AREAS.map((area) => ({
    title: area.title,
    // In the board's own order, whichever pane registered them first.
    commands: area.commands.flatMap((own) => {
      const c = commands.find((x) => x.id === own.id);
      return c ? [{ ...c, label: shortLabel(c.label, area.title) }] : [];
    }),
    fixed: area.fixed,
  }));
  return [everywhere, ...areas];
}

/** The default key of a command: as registered, else from its board's list. */
export function helpDefaultBinding(commandId: string, registeredDefault: ShortcutBinding | null): ShortcutBinding | null {
  if (registeredDefault) return registeredDefault;
  for (const area of SHORTCUT_AREAS) {
    const c = area.commands.find((x) => x.id === commandId);
    if (c) return bindingOf(c.binding);
  }
  return null;
}

/**
 * The label of the command `binding` would collide with if `commandId` took
 * it, or null when it's free (see the rule at the top of this file).
 */
export function helpBindingConflict(
  binding: ShortcutBinding,
  commandId: string,
  registered: readonly Shortcut[],
  overrides: Readonly<Record<string, ShortcutBinding>>,
): string | null {
  const area = areaOf(commandId);
  for (const other of allCommands(registered, overrides)) {
    if (other.id === commandId || !sameBinding(other.binding, binding)) continue;
    const otherArea = areaOf(other.id);
    if (area === null || otherArea === null || otherArea === area) return other.label;
  }
  return null;
}
