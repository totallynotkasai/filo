/**
 * A reactive loop between an editor `update` and a Svelte effect can re-queue
 * itself through microtasks forever: Svelte's depth guard never fires and the
 * starved timers mean the test timeout can't either, so the run hangs instead
 * of failing. Past this many `update` events since the last reset, throw so
 * the loop breaks and the test goes red with a reason. Real opens, closes and
 * edits in the suites stay far below it.
 */
import { Editor } from '@tiptap/core';

export const EDITOR_UPDATE_LOOP_LIMIT = 500;

let updates = 0;
let installed = false;

export function installEditorLoopBreaker(): void {
  if (installed) return;
  installed = true;
  const origEmit = Editor.prototype.emit;
  Editor.prototype.emit = function (this: Editor, event: string, ...args: unknown[]) {
    if (event === 'update' && ++updates > EDITOR_UPDATE_LOOP_LIMIT) {
      updates = 0;
      throw new Error(`editor update loop: more than ${EDITOR_UPDATE_LOOP_LIMIT} 'update' events in one test`);
    }
    return (origEmit as (this: Editor, e: string, ...a: unknown[]) => Editor).call(this, event, ...args);
  } as typeof origEmit;
}

export function resetEditorLoopBreaker(): void {
  updates = 0;
}
