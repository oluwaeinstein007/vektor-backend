// Local stand-in for Keycloak's JWKS endpoint plus a token-minting
// convenience — NOT Keycloak, never wire this into anything but local dev.
// Every real deployment authenticates via the actual Keycloak realm
// (vektor-infra/terraform/modules/gateway); this exists only because that
// realm isn't a local-dev-loop fit, and createTestAuth() (testing.ts) is an
// in-process fixture whose keypair a separately-running service process has
// no way to fetch as a JWKS.
//
// Run: pnpm --filter @vektor/auth dev:auth-bridge
// Then point any local service's KEYCLOAK_JWKS_URI at
// http://localhost:<port>/certs, and mint a token with e.g.:
//   curl "http://localhost:4477/mint?role=Commander&sub=dev-operator"
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { ROLES, isRole } from "./roles.js";

const PORT = Number(process.env.DEV_AUTH_BRIDGE_PORT ?? 4477);
const TOKEN_TTL = "12h";
const KID = "dev-auth-bridge-1";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/certs") {
      sendJson(res, 200, jwks);
      return;
    }

    if (url.pathname === "/mint") {
      const role = url.searchParams.get("role") ?? "Analyst";
      const sub = url.searchParams.get("sub") ?? "dev-operator";
      if (!isRole(role)) {
        sendJson(res, 400, { error: `role must be one of: ${ROLES.join(", ")}` });
        return;
      }

      void new SignJWT({ realm_access: { roles: [role] }, preferred_username: sub })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime(TOKEN_TTL)
        .sign(privateKey)
        .then((token) => sendJson(res, 200, { token, role, sub, expires_in: TOKEN_TTL }));
      return;
    }

    sendJson(res, 404, { error: "not found", routes: ["/certs", "/mint?role=<role>&sub=<id>"] });
  });

  server.listen(PORT, () => {
    console.log("[dev-auth-bridge] DEV-ONLY AUTH BRIDGE — NOT KEYCLOAK, NEVER USE OUTSIDE LOCAL DEV");
    console.log(`[dev-auth-bridge] listening on http://localhost:${PORT}`);
    console.log(`[dev-auth-bridge] point a local service's KEYCLOAK_JWKS_URI at http://localhost:${PORT}/certs`);
    console.log(`[dev-auth-bridge] mint a token: curl "http://localhost:${PORT}/mint?role=Commander&sub=dev-operator"`);
    console.log(`[dev-auth-bridge] roles: ${ROLES.join(", ")}`);
  });
}

main().catch((err: unknown) => {
  console.error("[dev-auth-bridge] failed to start", err);
  process.exit(1);
});
