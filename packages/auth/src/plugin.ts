import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createJwtVerifier, JwtVerificationError, type JwtVerifierOptions, type VektorJwtPayload } from "./jwt.js";
import { satisfiesRequirement, type RoleRequirement } from "./roles.js";

declare module "fastify" {
  interface FastifyInstance {
    requireRole(requirement: RoleRequirement): preHandlerHookHandler;
  }
  interface FastifyRequest {
    user?: VektorJwtPayload;
  }
}

export interface VektorAuthPluginOptions extends JwtVerifierOptions {}

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

    app.decorate("requireRole", (requirement: RoleRequirement): preHandlerHookHandler => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const token = extractBearerToken(request);
        if (!token) {
          return reply.code(401).send({ error: "missing bearer token" });
        }

        try {
          request.user = await verify(token);
        } catch (err) {
          const message = err instanceof JwtVerificationError ? err.message : "invalid token";
          return reply.code(401).send({ error: message });
        }

        if (!satisfiesRequirement(request.user.role, requirement)) {
          return reply.code(403).send({
            error: `role '${request.user.role}' does not satisfy requirement '${requirement}'`,
          });
        }
      };
    });
  },
  { name: "vektor-auth" },
);
