/**
 * Runs `fn` on every item, at most `limit` at a time, starting them in order.
 * Resolves once every call has settled; a call that rejects rejects the whole
 * run only after the others have settled (so no write is left running unseen).
 *
 * For work that waits on the disk (a sweep over many notes): one file at a
 * time leaves the disk idle between requests, and all at once floods it.
 */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: { err: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        await fn(items[index]!, index);
      } catch (err) {
        firstError ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (firstError) throw (firstError as { err: unknown }).err;
}
