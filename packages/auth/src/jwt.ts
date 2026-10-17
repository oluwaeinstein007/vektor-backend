// Verifies Keycloak-issued access tokens (§5.1: every human role authenticates
// via Keycloak SSO). Keycloak puts a user's realm roles at
// `realm_access.roles` — a *list*, because Keycloak itself has no concept of
// "the one VEKTOR role"; a token can carry roles this module doesn't know
// about (other realm clients) alongside the one VEKTOR role that matters.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import { ROLES, isRole, type Role } from "./roles.js";

/**
 * NW-015. Duplicated from @vektor/db's schema/orgConstants.ts rather than
 * imported: packages/auth deliberately has no dependency on packages/db —
 * it is used by services that never open a database connection (and by
 * vektor-edge), and adding drizzle + postgres to its dependency tree to
 * share one constant would be the wrong trade. The value is a fixed uuid
 * and is asserted to match in packages/auth/tests/jwt.test.ts.
 */
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VektorJwtPayload {
  sub: string;
  preferred_username?: string;
  role: Role;
  /**
   * NW-015: the organisation this principal acts for. Read from the token's
   * `org_id` claim, falling back to DEFAULT_ORG_ID when the claim is absent.
   *
   * The fallback is what keeps single-tenant deployments working untouched:
   * the existing Keycloak realm emits no such claim, and every row in the
   * database already belongs to the default organisation, so an unmodified
   * realm keeps resolving to exactly the data it resolved to before. A
   * multi-tenant deployment adds a protocol mapper that puts the user's
   * organisation in `org_id`, and nothing else has to change.
   *
   * Deliberately NOT a lookup. Resolving tenancy must stay free at the
   * point of use: the sensor-to-operator leg measures p95 ~2s end to end
   * and has no slack for a per-request round-trip, so the org travels in
   * the token that was already being verified.
   */
  org_id: string;
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

    // Absent is fine and means the default organisation (see the field's
    // doc comment). Present-but-malformed is NOT fine and must not quietly
    // degrade to the default: a token asserting an organisation this code
    // cannot parse is a token whose scope is unknown, and silently treating
    // it as the default organisation would hand it the single-tenant
    // deployment's entire dataset.
    const orgClaim = payload.org_id;
    let org_id: string;
    if (orgClaim === undefined || orgClaim === null) {
      org_id = DEFAULT_ORG_ID;
    } else if (typeof orgClaim === "string" && ORG_ID_RE.test(orgClaim)) {
      org_id = orgClaim;
    } else {
      throw new JwtVerificationError(
        `token's org_id claim is not a uuid: ${JSON.stringify(orgClaim)}`,
      );
    }

    return { sub, preferred_username, role, org_id };
  };
}
