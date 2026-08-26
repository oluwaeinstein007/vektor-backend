// Verifies Keycloak-issued access tokens (§5.1: every human role authenticates
// via Keycloak SSO). Keycloak puts a user's realm roles at
// `realm_access.roles` — a *list*, because Keycloak itself has no concept of
// "the one VEKTOR role"; a token can carry roles this module doesn't know
// about (other realm clients) alongside the one VEKTOR role that matters.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import { ROLES, isRole, type Role } from "./roles.js";

export interface VektorJwtPayload {
  sub: string;
  preferred_username?: string;
  role: Role;
}

export class JwtVerificationError extends Error {}

export interface JwtVerifierOptions {
  /** Real deployment: Keycloak's JWKS endpoint, e.g. `${issuer}/protocol/openid-connect/certs`. */
  jwksUri?: string;
  /** Tests / offline dev: a JWKS object signed with a keypair the test controls — no network involved. */
  localJwks?: JSONWebKeySet;
  issuer?: string;
  audience?: string;
}

// Highest-privilege-first: a token can legally carry more than one VEKTOR
// role (e.g. a Commander who is also provisioned as an Analyst); the
// verified principal acts as the single most-privileged one it holds, since
// every requireRole() check in this package is framed as a minimum bar, not
// an exact-match.
const RANK: readonly Role[] = ["SuperAdmin", "Commander", "Logistics Officer", "Analyst", "Field Operator", "Viewer"];

function pickPrimaryRole(candidateRoles: readonly string[]): Role | undefined {
  const held = new Set(candidateRoles.filter(isRole));
  return RANK.find((r) => held.has(r));
}

export function createJwtVerifier(options: JwtVerifierOptions): (token: string) => Promise<VektorJwtPayload> {
  if (!options.jwksUri && !options.localJwks) {
    throw new Error("createJwtVerifier requires either jwksUri or localJwks");
  }

  const getKey: JWTVerifyGetKey = options.jwksUri
    ? createRemoteJWKSet(new URL(options.jwksUri))
    : createLocalJWKSet(options.localJwks!);

  return async function verify(token: string): Promise<VektorJwtPayload> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
      });
      payload = result.payload;
    } catch (err) {
      throw new JwtVerificationError(err instanceof Error ? err.message : "invalid token");
    }

    const sub = payload.sub;
    if (typeof sub !== "string") {
      throw new JwtVerificationError("token missing sub claim");
    }

    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const rolesClaim = Array.isArray(realmAccess?.roles) ? (realmAccess!.roles as unknown[]) : [];
    const role = pickPrimaryRole(rolesClaim.filter((r): r is string => typeof r === "string"));
    if (!role) {
      throw new JwtVerificationError(
        `token's realm_access.roles carried none of ${ROLES.join(", ")}`,
      );
    }

    const preferred_username = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;

    return { sub, preferred_username, role };
  };
}
