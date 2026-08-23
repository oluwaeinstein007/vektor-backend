import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

// $client exposes the underlying postgres.js connection pool so callers
// (tests, graceful-shutdown handlers) can close it — drizzle() returns this
// intersection at runtime already; VektorDb just types it, so `db.$client.end()`
// doesn't need an `as any` at every call site.
export type VektorDb = PostgresJsDatabase<typeof schema> & { $client: Sql };

/**
 * Every service builds its Drizzle client through this factory rather than
 * calling `drizzle(postgres(...))` directly, so connection pooling/SSL
 * config stay in one place instead of drifting per service — same reasoning
 * as packages/kafka's createKafkaClient.
 */
export function createDb(connectionString: string): VektorDb {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}
