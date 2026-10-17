// Shared test fixture so every service's integration tests exercise the
// *real* requireRole()/JWT-verification path (real RS256 sign + verify)
// without each one re-deriving RSA keypair + JWKS boilerplate, and without
// needing a live Keycloak. Not a mock of auth — a real keypair the test
// happens to control, exactly jose's own documented pattern for testing
// JWKS-backed verification offline.
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import type { VektorAuthPluginOptions } from "./plugin.js";
import type { Role } from "./roles.js";

export interface TestTokenOptions {
  sub: string;
  roles: Role[];
  preferred_username?: string;
  /** NW-015: omit to exercise the default-organisation fallback. */
  org_id?: string;
}

export interface TestAuth {
  /** Pass straight through as a service's `auth` BuildAppOptions field. */
  authOptions: VektorAuthPluginOptions;
  signToken(options: TestTokenOptions): Promise<string>;
  authHeader(options: TestTokenOptions): Promise<{ authorization: string }>;
}

const KID = "test-key-1";

export async function createTestAuth(): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };

  async function signToken(options: TestTokenOptions): Promise<string> {
    return new SignJWT({
      realm_access: { roles: options.roles },
      preferred_username: options.preferred_username,
      // Only set when asked, so the default-organisation fallback is what
      // every pre-NW-015 test keeps exercising.
      ...(options.org_id === undefined ? {} : { org_id: options.org_id }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setSubject(options.sub)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  }

  return {
    authOptions: { localJwks: jwks },
    signToken,
    authHeader: async (options) => ({ authorization: `Bearer ${await signToken(options)}` }),
  };
}
