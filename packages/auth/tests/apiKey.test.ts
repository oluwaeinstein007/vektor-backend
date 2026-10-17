// NW-017: the API-key credential, its rate limit, and both of them wired
// through a real Fastify instance alongside the existing JWT path.
//
// No mocks of the crypto: these mint real keys, hash them the way the
// database stores them, and verify them back. The point of a credential
// test is that the thing which says "valid" is the same code that will say
// it in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  mintApiKey,
  parseApiKey,
  hashSecret,
  verifySecret,
  verifyApiKey,
  hasScope,
  ApiKeyError,
  type ApiKeyRecord,
} from "../src/apiKey.js";
import { checkRateLimit, InMemoryRateLimitStore } from "../src/rateLimit.js";
import { vektorAuthPlugin } from "../src/plugin.js";
import { createTestAuth } from "../src/testing.js";
import { DEFAULT_ORG_ID } from "../src/jwt.js";

const ORG_B = "00000000-0000-0000-0000-0000000000b2";

function recordFor(minted: ReturnType<typeof mintApiKey>, overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "11111111-1111-1111-1111-111111111111",
    org_id: DEFAULT_ORG_ID,
    secret_hash: minted.secret_hash,
    scopes: ["entities:read"],
    role: "Analyst",
    rate_limit_per_min: 60,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

test("a minted key round-trips: parse, then verify against the stored hash", () => {
  const minted = mintApiKey();
  assert.match(minted.token, /^vk_[0-9a-f]{12}_[0-9a-f]{64}$/);

  const parsed = parseApiKey(minted.token);
  assert.ok(parsed);
  assert.equal(parsed.key_prefix, minted.key_prefix);

  // The stored hash is of the SECRET half only — hashing the whole token
  // would make the prefix unrecoverable from the row and break lookup.
  assert.equal(hashSecret(parsed.secret), minted.secret_hash);
  assert.ok(verifySecret(parsed.secret, minted.secret_hash));

  const verified = verifyApiKey(recordFor(minted), parsed.secret);
  assert.equal(verified.role, "Analyst");
  assert.equal(verified.org_id, DEFAULT_ORG_ID);
});

test("two mints never collide and the secret is not derivable from the prefix", () => {
  const a = mintApiKey();
  const b = mintApiKey();
  assert.notEqual(a.key_prefix, b.key_prefix);
  assert.notEqual(a.secret_hash, b.secret_hash);
  // The token is the only place the secret ever exists in clear.
  assert.ok(!a.secret_hash.includes(a.key_prefix));
});

test("parseApiKey rejects anything that is not exactly the key format", () => {
  for (const bad of [
    "",
    "vk_short_abc",
    "notakey",
    "Bearer vk_aaaaaaaaaaaa_" + "a".repeat(64),
    "vk_AAAAAAAAAAAA_" + "a".repeat(64), // uppercase hex
    "vk_aaaaaaaaaaaa_" + "a".repeat(63), // one char short
  ]) {
    assert.equal(parseApiKey(bad), undefined, `should not parse: ${bad}`);
  }
  // A JWT must not parse as an API key, or the plugin would route it down
  // the wrong verification path and reject every human login.
  assert.equal(parseApiKey("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig"), undefined);
});

test("a wrong secret is rejected, and a corrupt stored hash fails closed rather than throwing", () => {
  const minted = mintApiKey();
  const other = mintApiKey();
  assert.ok(!verifySecret(parseApiKey(other.token)!.secret, minted.secret_hash));
  // Length mismatch would make timingSafeEqual throw, turning a bad
  // credential into a 500. It must simply be false.
  assert.equal(verifySecret("abc", "deadbeef"), false);
  assert.equal(verifySecret("abc", "not-hex-at-all"), false);
});

test("revoked and expired keys are refused, but only after the secret checks out", () => {
  const minted = mintApiKey();
  const secret = parseApiKey(minted.token)!.secret;
  const past = new Date(Date.now() - 1000);

  assert.throws(() => verifyApiKey(recordFor(minted, { revoked_at: past }), secret), ApiKeyError);
  assert.throws(() => verifyApiKey(recordFor(minted, { expires_at: past }), secret), ApiKeyError);

  // A future expiry is fine.
  const future = new Date(Date.now() + 60_000);
  assert.ok(verifyApiKey(recordFor(minted, { expires_at: future }), secret));

  // Order matters: a WRONG secret against a REVOKED key must report the
  // same thing as a wrong secret against a live one, or the error message
  // becomes an oracle for which prefixes exist and which were revoked.
  let revokedMsg = "";
  try {
    verifyApiKey(recordFor(minted, { revoked_at: past }), "0".repeat(64));
  } catch (e) {
    revokedMsg = (e as Error).message;
  }
  let liveMsg = "";
  try {
    verifyApiKey(recordFor(minted), "0".repeat(64));
  } catch (e) {
    liveMsg = (e as Error).message;
  }
  assert.equal(revokedMsg, liveMsg);
  assert.equal(revokedMsg, "invalid api key");
});

test("a key carrying a role outside the six is refused rather than downgraded", () => {
  const minted = mintApiKey();
  const secret = parseApiKey(minted.token)!.secret;
  assert.throws(() => verifyApiKey(recordFor(minted, { role: "Superuser" }), secret), ApiKeyError);
  assert.throws(() => verifyApiKey(recordFor(minted, { role: "" }), secret), ApiKeyError);
});

test("scope matching supports one trailing wildcard segment and nothing broader", () => {
  assert.ok(hasScope(["entities:read"], "entities:read"));
  assert.ok(hasScope(["entities:*"], "entities:read"));
  assert.ok(hasScope(["entities:*"], "entities:write"));

  assert.ok(!hasScope(["entities:read"], "entities:write"));
  assert.ok(!hasScope(["entities:*"], "coa:read"));
  assert.ok(!hasScope([], "entities:read"));
  // A bare "*" is deliberately NOT a superuser scope — it would silently
  // include scopes invented after the key was issued.
  assert.ok(!hasScope(["*"], "entities:read"));
});

test("the rate limiter allows up to the limit, refuses past it, and resets with the window", async () => {
  const store = new InMemoryRateLimitStore();
  const at = new Date("2026-10-18T12:00:30Z");

  for (let i = 1; i <= 3; i++) {
    const r = await checkRateLimit(store, "key-1", 3, at);
    assert.equal(r.allowed, true, `request ${i} should be allowed`);
    assert.equal(r.count, i);
  }
  const over = await checkRateLimit(store, "key-1", 3, at);
  assert.equal(over.allowed, false);
  assert.equal(over.resetSeconds, 30); // 30s into a 60s window

  // A different key has its own budget — limits are per key, not global.
  assert.equal((await checkRateLimit(store, "key-2", 3, at)).allowed, true);

  // Next window: the key name contains the window number, so this is a
  // fresh counter rather than a TTL that needed to expire first.
  const nextWindow = new Date("2026-10-18T12:01:05Z");
  const after = await checkRateLimit(store, "key-1", 3, nextWindow);
  assert.equal(after.allowed, true);
  assert.equal(after.count, 1);
});

/** Builds an app whose one route needs `entities:read` and Analyst+. */
async function buildApp(opts: {
  record?: ApiKeyRecord;
  store?: InMemoryRateLimitStore;
  loadThrows?: boolean;
  onUsed?: (id: string) => void;
}) {
  const testAuth = await createTestAuth();
  const app = Fastify();
  await app.register(vektorAuthPlugin, {
    ...testAuth.authOptions,
    apiKeys: {
      load: async (_prefix: string) => {
        if (opts.loadThrows) throw new Error("database is down");
        return opts.record;
      },
      store: opts.store,
      onUsed: opts.onUsed,
    },
  });
  app.get("/thing", { preHandler: app.requireScope("entities:read", "analyst+") }, async (req) => ({
    sub: req.user!.sub,
    org_id: req.user!.org_id,
    viaApiKey: req.apiKey !== undefined,
  }));
  await app.ready();
  return { app, testAuth };
}

test("plugin: a valid API key authenticates, carries its organisation, and is marked as a key", async (t) => {
  const minted = mintApiKey();
  const used: string[] = [];
  const { app } = await buildApp({
    record: recordFor(minted, { org_id: ORG_B }),
    onUsed: (id) => used.push(id),
  });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/thing", headers: { authorization: `Bearer ${minted.token}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.viaApiKey, true);
  assert.equal(body.org_id, ORG_B, "the key's organisation must reach the request, not the default");
  assert.match(body.sub, /^apikey:/, "a key's subject must be distinguishable from a Keycloak sub");
  assert.deepEqual(used, ["11111111-1111-1111-1111-111111111111"]);
});

test("plugin: a human JWT still works on the same route and has no scopes to satisfy", async (t) => {
  const minted = mintApiKey();
  const { app, testAuth } = await buildApp({ record: recordFor(minted) });
  t.after(() => app.close());

  const res = await app.inject({
    method: "GET",
    url: "/thing",
    headers: await testAuth.authHeader({ sub: "operator-1", roles: ["Analyst"] }),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.viaApiKey, false);
  assert.equal(body.org_id, DEFAULT_ORG_ID, "a token with no org_id claim falls back to the default org");
});

test("plugin: a key missing the route's scope is 403, not 401", async (t) => {
  const minted = mintApiKey();
  const { app } = await buildApp({ record: recordFor(minted, { scopes: ["coa:read"] }) });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/thing", headers: { authorization: `Bearer ${minted.token}` } });
  assert.equal(res.statusCode, 403, "the credential is valid; it is the authorisation that fails");
  assert.match(res.json().error, /scope/);
});

test("plugin: a key whose role is below the route's requirement is 403", async (t) => {
  const minted = mintApiKey();
  const { app } = await buildApp({ record: recordFor(minted, { role: "Viewer", scopes: ["entities:*"] }) });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/thing", headers: { authorization: `Bearer ${minted.token}` } });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /does not satisfy/);
});

test("plugin: a revoked key is 401 and says so", async (t) => {
  const minted = mintApiKey();
  const { app } = await buildApp({ record: recordFor(minted, { revoked_at: new Date(Date.now() - 1000) }) });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/thing", headers: { authorization: `Bearer ${minted.token}` } });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /revoked/);
});

test("plugin: exceeding the rate limit is 429 with Retry-After and rate-limit headers", async (t) => {
  const minted = mintApiKey();
  const store = new InMemoryRateLimitStore();
  const { app } = await buildApp({ record: recordFor(minted, { rate_limit_per_min: 2 }), store });
  t.after(() => app.close());

  const headers = { authorization: `Bearer ${minted.token}` };
  const first = await app.inject({ method: "GET", url: "/thing", headers });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-ratelimit-limit"], "2");
  assert.equal(first.headers["x-ratelimit-remaining"], "1");

  assert.equal((await app.inject({ method: "GET", url: "/thing", headers })).statusCode, 200);

  const third = await app.inject({ method: "GET", url: "/thing", headers });
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers["x-ratelimit-remaining"], "0");
  // Without Retry-After a client has nothing to back off on and will hot-loop.
  assert.ok(third.headers["retry-after"], "a 429 must tell the caller when to retry");
});

test("plugin: a loader failure is 503, not 401 — a key must not look invalid because the database is down", async (t) => {
  const minted = mintApiKey();
  const { app } = await buildApp({ record: recordFor(minted), loadThrows: true });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/thing", headers: { authorization: `Bearer ${minted.token}` } });
  assert.equal(res.statusCode, 503, "telling an integrator to rotate a working key is the wrong failure");
});

test("plugin: no credential at all is still 401", async (t) => {
  const minted = mintApiKey();
  const { app } = await buildApp({ record: recordFor(minted) });
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: "/thing" })).statusCode, 401);
});
