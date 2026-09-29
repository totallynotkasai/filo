/**
 * Feeds the save indicator from the same answer close and quit use
 * (`unsavedWork()`), with two refinements:
 *  - a change held for the user's decision (a conflict, a deleted or missing
 *    note) is neither "saving" nor "failed": nothing will write it until the
 *    user answers, so it shows as waiting for a decision;
 *  - a failure its owner already reported, with nothing left to retry, is
 *    listed in the popover without turning the indicator red.
 */
import { vaultPath } from '@shared/vaultPath';
import { saveStateStore } from './saveState.svelte';
import { heldDecisionPaths, heldDecisions } from './heldDecisions';
import { reportedFailedPaths, unsavedWork } from '../lib/boards/writeStateTracking';

export function pushSaveState(): void {
  const work = unsavedWork();
  const decisions = heldDecisions();
  const held = new Set(heldDecisionPaths().map((p) => vaultPath(p)));
  const failed = work.failed.filter((p) => !held.has(p));
  const pending = work.pending.filter((p) => !held.has(p));
  saveStateStore.setDecisions(decisions.map((d) => ({ key: d.key, relPath: d.relPath(), text: d.text })));
  saveStateStore.setReportedPaths(reportedFailedPaths());
  saveStateStore.setStatus(work.inflight, failed.length, pending.length, decisions.length);
  for (const path of failed) saveStateStore.noteFailedPath(path);
}
