// packages/auth/src/rateLimit.ts — NW-017, REQ-8.5's "subject to its own
// rate limits".
//
// The store is an interface rather than an ioredis import on purpose.
// packages/auth is depended on by services that never open a Redis
// connection, and by vektor-edge, which runs profiles with no Redis at all;
// adding ioredis here would put it in all of their dependency trees for a
// feature most of them do not use. The structural type below is satisfied
// by an ioredis client as-is, so a service wires one in with no adapter.
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

/**
 * Fixed-window counter, keyed per API key per minute.
 *
 * Fixed window, not sliding, and the tradeoff is worth stating because it
 * is visible to an integrator: a client can send `limit` requests in the
 * last second of one window and `limit` again in the first second of the
 * next, so the true worst-case burst is 2x over a window boundary. A
 * sliding-window or token-bucket implementation removes that, at the cost
 * of either a sorted set per key (memory proportional to request rate) or a
 * Lua script to make the read-modify-write atomic.
 *
 * Fixed window is the right starting point here because the limit exists to
 * stop a runaway integration from saturating the API, and 2x a per-minute
 * cap for one second does not do that. It is NOT adequate if these limits
 * ever become a billing boundary rather than a safety one — at that point
 * the burst is something a customer can notice and dispute, and it should
 * move to a token bucket.
 *
 * INCR-then-EXPIRE is two round-trips and not atomic. If the process dies
 * between them the key has no TTL and the limit sticks until something
 * clears it, so EXPIRE is issued on every increment rather than only when
 * the counter is 1 — that way any later request repairs a missing TTL.
 * Refreshing the TTL does not extend the window, because the key name
 * already contains the window number.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  keyId: string,
  limitPerMin: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowSeconds = 60;
  const windowNumber = Math.floor(now.getTime() / 1000 / windowSeconds);
  const redisKey = `vektor:ratelimit:${keyId}:${windowNumber}`;

  const count = await store.incr(redisKey);
  // Twice the window, so a clock skew between processes cannot expire a
  // window that is still in use by another one.
  await store.expire(redisKey, windowSeconds * 2);

  const elapsedInWindow = Math.floor(now.getTime() / 1000) % windowSeconds;
  return {
    allowed: count <= limitPerMin,
    count,
    limit: limitPerMin,
    resetSeconds: windowSeconds - elapsedInWindow,
  };
}

/**
 * Single-process store for tests and for the edge profile, which runs
 * without Redis. Not shared between processes, so in a multi-replica
 * deployment each replica would enforce the limit independently — which is
 * why a real cloud deployment must pass the Redis client instead.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, { n: number; expiresAt: number }>();

  async incr(key: string): Promise<number> {
    const now = Date.now();
    const existing = this.counts.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.counts.set(key, { n: 1, expiresAt: now + 120_000 });
      return 1;
    }
    existing.n += 1;
    return existing.n;
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    const existing = this.counts.get(key);
    if (existing) existing.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  /** Test helper — drops every counter. */
  reset(): void {
    this.counts.clear();
  }
}
