// packages/connector-sdk/src/reconnect.ts — NW-019.
//
// This exists because the hand-written adapters do not have it. `aisAdapter`
// opens a TCP socket, reports errors to `onError`, and never reconnects:
// when an AIS aggregator drops the connection — which they do, routinely —
// the feed stops, ingest-svc stays up and healthy, and nothing says the
// sensor has gone quiet. Same class as the other "green while doing
// nothing" failures found in this codebase.
//
// Giving every connector reconnection for free, rather than asking each
// third-party author to get exponential backoff right, is a large part of
// what the SDK is for.

export interface BackoffOptions {
  /** First delay. Doubles from here. */
  initialMs?: number;
  maxMs?: number;
  /**
   * Fraction of the delay to randomise, 0..1. Defaults to 0.2.
   *
   * Not decoration. Without jitter, every connector that lost its
   * connection to the same broker reconnects at the same instants forever
   * — a thundering herd that keeps the broker from recovering and makes
   * the outage self-sustaining.
   */
  jitter?: number;
  /** Give up after this many consecutive failures. Default: never. */
  maxAttempts?: number;
}

export function nextDelayMs(attempt: number, options: BackoffOptions = {}, random: () => number = Math.random): number {
  const initial = options.initialMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const jitter = options.jitter ?? 0.2;
  const base = Math.min(max, initial * 2 ** Math.max(0, attempt - 1));
  // Symmetric around `base`, so jitter does not systematically slow
  // reconnection the way a purely additive jitter does.
  const spread = base * jitter;
  return Math.max(0, Math.round(base - spread + random() * spread * 2));
}

export interface ReconnectingSession {
  /** Resolves when the session ends normally; rejects to trigger a retry. */
  closed: Promise<void>;
  stop(): Promise<void> | void;
}

export interface RunWithReconnectOptions extends BackoffOptions {
  signal: AbortSignal;
  /** Opens one session. Called again after each failure. */
  connect(): Promise<ReconnectingSession> | ReconnectingSession;
  onReconnect?(attempt: number, delayMs: number, err: Error): void;
  onGiveUp?(attempts: number, err: Error): void;
  /** Injectable for tests. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps a session alive across failures until the signal aborts.
 *
 * Returns a handle whose `stop()` both aborts and closes the live session,
 * so a shutdown does not race a pending reconnect into opening a socket
 * nobody will ever close.
 */
export async function runWithReconnect(options: RunWithReconnectOptions): Promise<{ stop(): Promise<void> }> {
  const sleep = options.sleep ?? defaultSleep;
  let current: ReconnectingSession | undefined;
  let stopped = false;

  /** Resolves as soon as stop() is called or the signal aborts. */
  function stopSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (stopped || options.signal.aborted) return resolve();
      const timer = setInterval(() => {
        if (stopped || options.signal.aborted) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      timer.unref?.();
      options.signal.addEventListener("abort", () => {
        clearInterval(timer);
        resolve();
      }, { once: true });
    });
  }

  const loop = (async () => {
    let attempt = 0;
    while (!stopped && !options.signal.aborted) {
      try {
        current = await options.connect();
        attempt = 0; // a successful connect resets the backoff
        // Raced against shutdown, not awaited bare. A session whose
        // `closed` never settles after its own stop() would otherwise
        // deadlock stop() forever — and a connector author getting that
        // subtly wrong must not be able to hang the whole service's
        // shutdown. The SDK owning this is most of why it exists.
        await Promise.race([current.closed, stopSignal()]);
        if (stopped || options.signal.aborted) return;
        // A clean close that was not asked for is still a dropped feed,
        // and is exactly the case the AIS adapter never handled.
        throw new Error("connection closed by peer");
      } catch (err) {
        current = undefined;
        if (stopped || options.signal.aborted) return;
        attempt += 1;
        const error = err instanceof Error ? err : new Error(String(err));
        if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) {
          options.onGiveUp?.(attempt, error);
          return;
        }
        const delay = nextDelayMs(attempt, options);
        options.onReconnect?.(attempt, delay, error);
        await sleep(delay, options.signal);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      try {
        await current?.stop();
      } finally {
        await loop;
      }
    },
  };
}
