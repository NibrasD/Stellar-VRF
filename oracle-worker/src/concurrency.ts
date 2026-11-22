/**
 * concurrency.ts — two small primitives for handling several requests at once.
 *
 * Why: requests used to be handled strictly one after another. Each one waits
 * ~9–12 s for its drand round and then a ledger for its transaction, so the
 * worker served only ~3–4 requests per minute and everything behind a burst
 * was late. With the contract's hard fulfillment deadline, "late" means the
 * request can only be refunded, so a few cheap requests could push other
 * users' requests past the window.
 *
 * Now the waiting (drand round, proof) runs concurrently, bounded by
 * `mapLimit`, and only the on-chain submission is serialized, per signing
 * account, by `KeyedMutex`: a Stellar account's transactions must use
 * consecutive sequence numbers, so two sends from one account must not
 * overlap.
 */

/** Run `fn` over `items` with at most `limit` in flight. Never rejects: `fn` must handle its own errors. */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const width = Math.max(1, Math.floor(limit));
  let next = 0;
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        // fn is expected to log; one failing item must not stop the others.
      }
    }
  });
  await Promise.all(runners);
}

/** FIFO mutual exclusion per key (e.g. per signing account). */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
