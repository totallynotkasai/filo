/**
 * Retry from a save-failed toast, and an honest answer afterwards.
 *
 * Retry fires every kept failed write again. What it came to is read from
 * the same ledger close and quit use (`unsavedWork().failed`) before and
 * after, so the toast names what still isn't on disk and why, worded per
 * kind: a board or note write is retried on every save anyway, a theme or
 * template save only from here, and a held decision by no retry at all.
 */
import { vaultPath } from '../../../shared/vaultPath';
import { retryAllFailedWrites } from './writeSchedulerFailures';
import { unsavedWork } from './writeStateTracking';
import { componentRetryPaths } from './componentWriteRetry';
import { retryResultText } from '../vault/unsavedMessages';
import { describeUnsaved } from '../../stores/unsavedRescue';
import { heldDecisions } from '../../stores/heldDecisions';
import { uiStore } from '../../stores/ui.svelte';

/** How long the "still not saved" toast stays. */
const STILL_FAILING_TOAST_MS = 12_000;

export async function retryAndReport(): Promise<void> {
  const before = new Set(unsavedWork().failed);
  await retryAllFailedWrites();
  const failed = unsavedWork().failed;
  const saved = [...before].filter((key) => !failed.includes(key)).length;
  const items = await describeUnsaved({ pending: [], failed, inflight: 0 });
  const result = retryResultText(items, saved, {
    componentKeys: new Set(componentRetryPaths().map((p) => vaultPath(p))),
    decisionKeys: new Set(heldDecisions().map((d) => vaultPath(d.relPath()))),
  });
  uiStore.pushToast({
    text: result.text,
    type: result.type,
    duration: result.type === 'success' ? 4000 : STILL_FAILING_TOAST_MS,
    dedupeKey: 'retry-result',
    actions: result.retryAgain ? [{ label: 'Retry again', handler: () => retryAndReport() }] : [],
  });
}
