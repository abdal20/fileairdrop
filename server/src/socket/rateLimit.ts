export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const current = this.now();
    const elapsed = (current - this.last) / 1000;
    this.last = current;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export class KeyedLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string, cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) this.prune();
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSecond), seen: Date.now() };
      this.buckets.set(key, entry);
    }
    entry.seen = Date.now();
    return entry.bucket.take(cost);
  }

  private prune() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, entry] of this.buckets) {
      if (entry.seen < cutoff) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}
