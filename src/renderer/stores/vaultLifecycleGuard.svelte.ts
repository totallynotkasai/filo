/**
 * vaultLifecycleGuard — one vault open or close at a time.
 *
 * An open tears the outgoing vault down, loads the new one and, when that
 * fails, releases the main-side registry it may have armed. A second open
 * started meanwhile (a click on a recent vault during the launch auto-open)
 * would interleave with it: its failure path could release the registry the
 * other open just armed, and every gated write would then be refused. So an
 * open or close that starts while another runs does nothing and says so
 * ('busy'); the Home screen shows which vault is opening and disables the
 * others.
 */

// allow-module-state: true only while an open or close runs; that call clears it in its finally, whatever happens
let busy = $state(false);

/** True while a vault open or close is running. */
export function vaultLifecycleBusy(): boolean {
  return busy;
}

/**
 * Runs `run` as the only vault open or close; while another runs, returns
 * `whenBusy()` instead without starting it.
 */
export async function exclusiveVaultLifecycle<T>(run: () => Promise<T>, whenBusy: () => T): Promise<T> {
  if (busy) return whenBusy();
  busy = true;
  try {
    return await run();
  } finally {
    busy = false;
  }
}
