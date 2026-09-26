/**
 * Vault slice — startup registration of the prompts the writers ask.
 *
 * The board drift prompt lives in `boardDrift.ts` (one prompt and one set of
 * actions for the watcher and the board writer); a `.filo/` settings file
 * changed outside Filo asks through `configDriftPrompt.ts`. Notes don't need a
 * Promise-based prompt: the note writer keeps a conflicting body queued and
 * the note store asks once (`notePrompts.ts`).
 */
import { setBoardExternalEditHandler } from '../lib/boards/boardWriteScheduler';
import { setConfigExternalHandlers } from '../lib/boards/configDrift';
import { resolveBoardDrift } from './boardDrift';
import { configExternalHandlers } from './configDriftPrompt';
import { registerNotePrompts } from './notePrompts';

/**
 * Installs the prompts the writers ask. `lib/` writers can't import
 * `stores/`, so they expose setters. App.svelte calls this at startup: by
 * then every module has finished evaluating, so the setters are always live.
 * Registering at module load instead would depend on evaluation order through
 * the store import cycles, and a cycle could leave a writer with no prompt.
 */
export function registerDriftPromptHandlers(): void {
  setBoardExternalEditHandler((path) => resolveBoardDrift(path));
  registerNotePrompts();
  setConfigExternalHandlers(configExternalHandlers);
}
