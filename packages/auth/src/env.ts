import type { JwtVerifierOptions } from "./jwt.js";

// Every service's index.ts calls this once instead of repeating the same
// three env vars — KEYCLOAK_JWKS_URI is required in any environment that
// actually serves traffic; a service with it unset fails at startup rather
// than silently accepting unverifiable tokens.
export function authOptionsFromEnv(): JwtVerifierOptions {
  const jwksUri = process.env.KEYCLOAK_JWKS_URI;
  if (!jwksUri) {
    throw new Error("KEYCLOAK_JWKS_URI is required (Keycloak's /protocol/openid-connect/certs endpoint)");
  }
  return {
    jwksUri,
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_AUDIENCE,
  };
}
