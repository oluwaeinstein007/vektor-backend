import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createJwtVerifier, JwtVerificationError, type JwtVerifierOptions, type VektorJwtPayload } from "./jwt.js";
import { satisfiesRequirement, type RoleRequirement } from "./roles.js";
import { ApiKeyError, hasScope, parseApiKey, verifyApiKey, type ApiKeyRecord, type VerifiedApiKey } from "./apiKey.js";
import { checkRateLimit, type RateLimitStore } from "./rateLimit.js";

declare module "fastify" {
  interface FastifyInstance {
    requireRole(requirement: RoleRequirement): preHandlerHookHandler;
    /** NW-017: additionally require an API-key scope. Human JWTs skip it. */
    requireScope(scope: string, requirement?: RoleRequirement): preHandlerHookHandler;
  }
  interface FastifyRequest {
    user?: VektorJwtPayload;
    /** Set only when the caller authenticated with an API key. */
    apiKey?: VerifiedApiKey;
  }
}

/**
 * NW-017. Supplying this enables API-key authentication; omitting it leaves
 * the service JWT-only, which is what every service did before NW-017 and
 * what the edge profile still wants.
 */
export interface ApiKeyAuthOptions {
  /**
   * Loads a key row by its public prefix. Provided by the service because
   * packages/auth deliberately has no database dependency — see
   * rateLimit.ts's header for the same reasoning applied to Redis.
   *
   * MUST bypass organisation RLS scoping: this runs BEFORE the request has
   * an organisation, and is what determines it. A loader that scopes by
   * `vektor.org_id` can never find the row and every key fails to
   * authenticate.
   */
  load(keyPrefix: string): Promise<ApiKeyRecord | undefined>;
  /** Omit to disable rate limiting (tests, single-tenant edge). */
  store?: RateLimitStore;
  /** Fire-and-forget hook for `last_used_at`. Never awaited on the request path. */
  onUsed?(keyId: string): void;
}

export interface VektorAuthPluginOptions extends JwtVerifierOptions {
  apiKeys?: ApiKeyAuthOptions;
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

// A fastify-plugin (not a plain FastifyPluginAsync) specifically so the
// `requireRole` decorator escapes this plugin's own encapsulation context —
// every route file registered as a *sibling* plugin needs to call
// `app.requireRole(...)`, which fastify-plugin's shared-context bypass is
// exactly for.
export const vektorAuthPlugin = fp<VektorAuthPluginOptions>(
  async (app: FastifyInstance, options) => {
    const verify = createJwtVerifier(options);
    const apiKeys = options.apiKeys;

    /**
     * Authenticates the request, by API key or by JWT, and populates
     * `request.user` either way so that every existing `requireRole()`
     * check keeps working without knowing which credential was used.
     *
     * Returns a reply when it has already answered the request.
     */
    async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
      const token = extractBearerToken(request);
      if (!token) return reply.code(401).send({ error: "missing bearer token" });

      const parsed = apiKeys ? parseApiKey(token) : undefined;
      if (!parsed) {
        // Not a `vk_`-shaped token, so treat it as a JWT. A malformed API
        // key therefore surfaces as a JWT error, which is a slightly
        // confusing message but the right behaviour: distinguishing them
        // would tell an unauthenticated caller which credential types this
        // deployment accepts.
        try {
          request.user = await verify(token);
        } catch (err) {
          const message = err instanceof JwtVerificationError ? err.message : "invalid token";
          return reply.code(401).send({ error: message });
        }
        return undefined;
      }

      let record: ApiKeyRecord | undefined;
      try {
        record = await apiKeys!.load(parsed.key_prefix);
      } catch {
        // A loader failure is ours, not the caller's. 503 rather than 401,
        // because telling an integrator their key is invalid when the
        // database is down sends them to rotate a key that was fine.
        return reply.code(503).send({ error: "unable to verify api key" });
      }
      if (!record) return reply.code(401).send({ error: "invalid api key" });

      let verified: VerifiedApiKey;
      try {
        verified = verifyApiKey(record, parsed.secret);
      } catch (err) {
        return reply.code(401).send({ error: err instanceof ApiKeyError ? err.message : "invalid api key" });
      }

      if (apiKeys!.store) {
        const limit = await checkRateLimit(apiKeys!.store, verified.key_id, verified.rate_limit_per_min);
        reply.header("x-ratelimit-limit", String(limit.limit));
        reply.header("x-ratelimit-remaining", String(Math.max(0, limit.limit - limit.count)));
        reply.header("x-ratelimit-reset", String(limit.resetSeconds));
        if (!limit.allowed) {
          // Retry-After is not optional on a 429 if you want clients to
          // back off sensibly rather than hot-loop.
          reply.header("retry-after", String(limit.resetSeconds));
          return reply.code(429).send({ error: "rate limit exceeded" });
        }
      }

      request.apiKey = verified;
      request.user = {
        // Namespaced so an audit row can never confuse a key id with a
        // Keycloak subject, and so `actor_user_id` stays readable.
        sub: `apikey:${verified.key_id}`,
        role: verified.role,
        org_id: verified.org_id,
      };

      apiKeys!.onUsed?.(verified.key_id);
      return undefined;
    }

    app.decorate("requireRole", (requirement: RoleRequirement): preHandlerHookHandler => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const answered = await authenticate(request, reply);
        if (answered) return answered;

        if (!satisfiesRequirement(request.user!.role, requirement)) {
          return reply.code(403).send({
            error: `role '${request.user!.role}' does not satisfy requirement '${requirement}'`,
          });
        }
      };
    });

    app.decorate("requireScope", (scope: string, requirement: RoleRequirement = "all"): preHandlerHookHandler => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const answered = await authenticate(request, reply);
        if (answered) return answered;

        if (!satisfiesRequirement(request.user!.role, requirement)) {
          return reply.code(403).send({
            error: `role '${request.user!.role}' does not satisfy requirement '${requirement}'`,
          });
        }

        // A human JWT has no scopes and is not expected to grow them —
        // scopes exist to narrow a machine credential below what its role
        // already allows. An operator who passed the role check has
        // already been authorised by RBAC.
        if (request.apiKey && !hasScope(request.apiKey.scopes, scope)) {
          return reply.code(403).send({ error: `api key is missing required scope '${scope}'` });
        }
      };
    });
  },
  { name: "vektor-auth" },
);
