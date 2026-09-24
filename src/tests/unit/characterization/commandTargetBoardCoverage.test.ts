/**
 * Phase 2 characterization — `Command.targetBoardId` coverage matrix.
 *
 * Per IMPLEMENTATION_PLAN_2026-05-27 §Phase 2:
 *
 *   "Every Command captures targetBoardId at construction; CI gate at error."
 *
 * Phase 2 landed — every concrete Command subclass under
 * `src/renderer/commands/` now declares `readonly targetBoardId: string`
 * and assigns it in its constructor. This test pins that contract: a
 * future command that forgets the field fails here in addition to the
 * `scripts/gates:commands-target-board` CI gate.
 *
 * "AST walk" is overkill here — the declaration form is consistent
 * across the codebase (`readonly targetBoardId: string;` + `this.targetBoardId = ...;`)
 * so a regex source-scan over `src/renderer/commands/**.ts` is sufficient
 * AND robust to file-grouping refactors. If a future command uses an
 * inherited-base-class pattern that hides the declaration, swap the
 * regex for a real ts-morph walk.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const COMMANDS_DIR = path.join(ROOT, 'src', 'renderer', 'commands');

interface CommandClassInfo {
  /** Source file, vault-relative-ish (`src/renderer/commands/<file>.ts`). */
  file: string;
  /** Bare class name, e.g. `AddTileCommand`. */
  name: string;
  /** Declares `readonly targetBoardId: string` on the class body. */
  declaresField: boolean;
  /** Assigns `this.targetBoardId = ...` in the constructor body. */
  assignsField: boolean;
}

/**
 * Scan every `.ts` file under `src/renderer/commands/` for class
 * declarations extending `Command`. For each, report whether the class
 * declares `readonly targetBoardId: string` and whether the constructor
 * assigns `this.targetBoardId = ...`. Both are required for the field
 * to participate in `historyStore.undo/redo`'s board guard
 * (`history.svelte.ts:353-360`).
 */
function discoverCommandClasses(): CommandClassInfo[] {
  const out: CommandClassInfo[] = [];
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    // Skip the abstract base + barrel index — neither declares a concrete
    // command class.
    if (entry.name === 'Command.ts' || entry.name === 'index.ts') continue;
    const filePath = path.join(COMMANDS_DIR, entry.name);
    const text = fs.readFileSync(filePath, 'utf-8');
    // `export class XCommand extends Command { ... }`
    const classRe = /export\s+class\s+(\w+)\s+extends\s+Command\b/g;
    for (const match of text.matchAll(classRe)) {
      const className = match[1];
      const classStart = match.index ?? 0;
      // Extract the class body via brace-balanced walk (mirrors
      // `vaultSwapResets.test.ts`'s extractBodyOf helper).
      const body = extractBraceBalancedBlock(text, classStart);
      const declaresField =
        /readonly\s+targetBoardId\s*:\s*string/.test(body);
      const assignsField =
        /this\.targetBoardId\s*=/.test(body);
      out.push({
        file: `src/renderer/commands/${entry.name}`,
        name: className,
        declaresField,
        assignsField,
      });
    }
  }
  // Sort for stable diffs.
  out.sort((a, b) =>
    a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file),
  );
  return out;
}

function extractBraceBalancedBlock(text: string, startIndex: number): string {
  const braceStart = text.indexOf('{', startIndex);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return text.slice(braceStart);
}

const ALL_COMMAND_CLASSES = discoverCommandClasses();

// ── Tests ──────────────────────────────────────────────────────────────

describe('Phase 2 characterization — Command.targetBoardId coverage', () => {
  it('discovers a non-empty set of Command subclasses', () => {
    // Sanity check that the AST scan actually found classes. If a refactor
    // moves Command subclasses elsewhere (or splits them across folders),
    // this test fails loud so the discovery glob can be updated.
    expect(ALL_COMMAND_CLASSES.length).toBeGreaterThanOrEqual(30);
  });

  describe('every concrete Command declares + assigns `targetBoardId`', () => {
    for (const info of ALL_COMMAND_CLASSES) {
      // Phase 2 contract — every command MUST declare `readonly
      // targetBoardId: string` AND assign it in the constructor. Half-state
      // (declared without assignment, or assigned without declaration) is
      // a bug. Board-agnostic commands (ReplaceAllCommand, CascadeDeleteCommand)
      // still assign an empty string in their constructors so the gate
      // and this test pass; the dispatcher's truthy guard skips them.
      it(`${info.name} (${info.file}) — declares=${info.declaresField}, assigns=${info.assignsField}`, () => {
        expect(info.declaresField).toBe(true);
        expect(info.assignsField).toBe(true);
      });
    }
  });
});
