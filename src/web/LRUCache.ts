/**
 * Cost-bounded least-recently-used cache. `Map` keeps insertion order, so
 * re-inserting on access makes its first key the least recently used one.
 */
export class LRUCache<Value> {
  private readonly entries = new Map<string, { value: Value; cost: number }>();
  private totalCost = 0;

  constructor(
    private readonly costLimit: number,
    private readonly countLimit: number
  ) {}

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value, cost: number) {
    this.delete(key);
    // An entry larger than the whole budget would only evict everything else.
    if (cost > this.costLimit) {
      return;
    }
    this.entries.set(key, { value, cost });
    this.totalCost += cost;
    while (
      this.totalCost > this.costLimit ||
      this.entries.size > this.countLimit
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      this.entries.delete(key);
      this.totalCost -= entry.cost;
    }
  }
}
