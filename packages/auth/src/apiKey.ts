// packages/auth/src/apiKey.ts — NW-017, REQ-8.5.
//
// Minting, parsing and verifying integrator API keys. This file deals only
// with the credential itself; the Fastify wiring is in plugin.ts and the
// per-key rate limit is in rateLimit.ts.
//
// Key format:  vk_<prefix>_<secret>
//   prefix  12 hex chars  — public, stored in clear, indexed, finds the row
//   secret  64 hex chars  — 256 bits from a CSPRNG, stored only as SHA-256
//
// The two halves exist so verification is one indexed lookup plus one hash,
// rather than hashing the presented value against every key in the table.
// `vk_` makes a leaked key greppable in logs and in GitHub secret scanning,
// which is worth more than the three bytes it costs.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { isRole, type Role } from "./roles.js";

export const API_KEY_PREFIX_BYTES = 6; // 12 hex chars
export const API_KEY_SECRET_BYTES = 32; // 64 hex chars
const KEY_RE = /^vk_([0-9a-f]{12})_([0-9a-f]{64})$/;

export class ApiKeyError extends Error {}

export interface MintedApiKey {
  /** Shown to the operator exactly once. Never stored, never recoverable. */
  token: string;
  key_prefix: string;
  secret_hash: string;
}

/**
 * Generates a new key. The caller stores `key_prefix` and `secret_hash`
 * and shows `token` to the user once.
 *
 * There is deliberately no "reveal key" path anywhere in this package. A
 * key that can be re-read from the database is a key that is one SQL
 * injection or one over-broad support query away from being everyone's;
 * rotation (mint new, revoke old) is the supported recovery from a lost
 * key, and it is also the operation you actually want, because a key
 * someone lost track of should not keep working.
 */
export function mintApiKey(): MintedApiKey {
  const prefix = randomBytes(API_KEY_PREFIX_BYTES).toString("hex");
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString("hex");
  return {
    token: `vk_${prefix}_${secret}`,
    key_prefix: prefix,
    secret_hash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface ParsedApiKey {
  key_prefix: string;
  secret: string;
}

/** Splits a presented token. Returns undefined for anything malformed. */
export function parseApiKey(token: string): ParsedApiKey | undefined {
  const m = KEY_RE.exec(token.trim());
  if (!m) return undefined;
  return { key_prefix: m[1]!, secret: m[2]! };
}

/** True if `token` matches a stored hash. Constant-time in the secret. */
export function verifySecret(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws rather than returning false on a length
  // mismatch, which would turn a corrupt stored hash into a 500 instead of
  // a 401. Both operands are SHA-256 digests, so unequal lengths mean the
  // stored value is damaged, not that the caller guessed wrong.
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/** The stored row this package needs to make an auth decision. */
export interface ApiKeyRecord {
  key_id: string;
  org_id: string;
  secret_hash: string;
  scopes: readonly string[];
  role: string;
  rate_limit_per_min: number;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface VerifiedApiKey {
  key_id: string;
  org_id: string;
  role: Role;
  scopes: readonly string[];
  rate_limit_per_min: number;
}

/**
 * Validates a presented secret against a loaded record and returns the
 * principal it authorises.
 *
 * Order matters and is the opposite of the obvious one: the secret is
 * checked FIRST, before revocation and expiry. Checking cheap state first
 * would let an unauthenticated caller probe which key prefixes exist and
 * which have been revoked, by timing or by error message. A caller who
 * cannot produce the secret learns the same thing either way.
 */
export function verifyApiKey(record: ApiKeyRecord, secret: string, now: Date = new Date()): VerifiedApiKey {
  if (!verifySecret(secret, record.secret_hash)) {
    throw new ApiKeyError("invalid api key");
  }
  if (record.revoked_at !== null && record.revoked_at <= now) {
    throw new ApiKeyError("api key has been revoked");
  }
  if (record.expires_at !== null && record.expires_at <= now) {
    throw new ApiKeyError("api key has expired");
  }
  if (!isRole(record.role)) {
    // A role that isn't one of the six means the row was written by
    // something that doesn't share this vocabulary. Refusing is the only
    // safe reading: guessing "probably Viewer" would silently grant access
    // under a role nobody chose.
    throw new ApiKeyError(`api key carries an unknown role: ${JSON.stringify(record.role)}`);
  }
  return {
    key_id: record.key_id,
    org_id: record.org_id,
    role: record.role,
    scopes: record.scopes,
    rate_limit_per_min: record.rate_limit_per_min,
  };
}

/**
 * Scope check. Supports a single trailing wildcard segment (`entities:*`),
 * which is what makes a read-only key practical to issue without listing
 * every present and future endpoint.
 *
 * No `*` on its own: a key that holds every scope forever, including ones
 * added after it was issued, is indistinguishable from no scoping at all,
 * and it is exactly the key an integrator will ask for.
 */
export function hasScope(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true;
  const colon = required.indexOf(":");
  if (colon === -1) return false;
  return granted.includes(`${required.slice(0, colon)}:*`);
}
