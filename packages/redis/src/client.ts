import { Redis, type RedisOptions } from "ioredis";

/**
 * Every service builds its Redis client through this factory rather than
 * calling `new Redis(...)` directly, so connection config stays in one place
 * instead of drifting per service — same reasoning as packages/kafka's
 * createKafkaClient and packages/db's createDb. Accepts either a
 * `redis://` connection string (matching createDb's DATABASE_URL
 * convention) or an options object (handy for tests that only need host/port).
 */
export function createRedisClient(connection: string | RedisOptions): Redis {
  return typeof connection === "string" ? new Redis(connection) : new Redis(connection);
}

export { Redis };
export type { RedisOptions };
