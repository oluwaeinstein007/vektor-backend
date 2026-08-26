// Real RS256 signing + verification end to end — no mocked crypto and no
// live Keycloak needed: `createLocalJWKSet` lets this test hand jose the
// exact same JWKS shape Keycloak's `/protocol/openid-connect/certs`
// endpoint returns, just served from memory instead of over HTTP. A token
// that fails to verify here would also fail against a real Keycloak.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { vektorAuthPlugin } from "../src/plugin.js";
import type { Role } from "../src/roles.js";

async function buildTestKeyMaterial() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const publicJwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };

  async function signToken(claims: { sub: string; roles: string[]; preferred_username?: string }): Promise<string> {
    return new SignJWT({ realm_access: { roles: claims.roles }, preferred_username: claims.preferred_username })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  return { jwks, signToken };
}

async function buildTestApp(jwks: JSONWebKeySet) {
  const app = Fastify();
  await app.register(vektorAuthPlugin, { localJwks: jwks });

  app.get("/analyst-plus", { preHandler: app.requireRole("analyst+") }, async (request) => ({
    sub: request.user!.sub,
    role: request.user!.role,
  }));
  app.get("/commander-only", { preHandler: app.requireRole("commander") }, async (request) => ({
    role: request.user!.role,
  }));
  app.get("/superadmin-only", { preHandler: app.requireRole("superadmin") }, async (request) => ({
    role: request.user!.role,
  }));

  await app.ready();
  return app;
}

test("requireRole('analyst+') allows Analyst, Commander, SuperAdmin; rejects Viewer/Field Operator/Logistics Officer", async (t) => {
  const { jwks, signToken } = await buildTestKeyMaterial();
  const app = await buildTestApp(jwks);
  t.after(() => app.close());

  const allowed: Role[] = ["Analyst", "Commander", "SuperAdmin"];
  for (const role of allowed) {
    const token = await signToken({ sub: `user-${role}`, roles: [role] });
    const res = await app.inject({ method: "GET", url: "/analyst-plus", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200, `${role} should pass analyst+`);
    assert.deepEqual(res.json(), { sub: `user-${role}`, role });
  }

  const denied: Role[] = ["Viewer", "Field Operator", "Logistics Officer"];
  for (const role of denied) {
    const token = await signToken({ sub: `user-${role}`, roles: [role] });
    const res = await app.inject({ method: "GET", url: "/analyst-plus", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403, `${role} should be denied analyst+`);
  }
});

test("requireRole('commander') rejects Analyst but SuperAdmin still passes (platform-owner override)", async (t) => {
  const { jwks, signToken } = await buildTestKeyMaterial();
  const app = await buildTestApp(jwks);
  t.after(() => app.close());

  const analystToken = await signToken({ sub: "u1", roles: ["Analyst"] });
  const analystRes = await app.inject({ method: "GET", url: "/commander-only", headers: { authorization: `Bearer ${analystToken}` } });
  assert.equal(analystRes.statusCode, 403);

  const adminToken = await signToken({ sub: "u2", roles: ["SuperAdmin"] });
  const adminRes = await app.inject({ method: "GET", url: "/commander-only", headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(adminRes.statusCode, 200);
});

test("multi-role token acts as its most-privileged held role", async (t) => {
  const { jwks, signToken } = await buildTestKeyMaterial();
  const app = await buildTestApp(jwks);
  t.after(() => app.close());

  // A user provisioned as both Analyst and Commander in Keycloak.
  const token = await signToken({ sub: "u3", roles: ["Analyst", "Commander"] });
  const res = await app.inject({ method: "GET", url: "/commander-only", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { role: "Commander" });
});

test("missing bearer token -> 401; tampered signature -> 401; unknown role claim -> 401", async (t) => {
  const { jwks, signToken } = await buildTestKeyMaterial();
  const app = await buildTestApp(jwks);
  t.after(() => app.close());

  const noAuthRes = await app.inject({ method: "GET", url: "/superadmin-only" });
  assert.equal(noAuthRes.statusCode, 401);

  const validToken = await signToken({ sub: "u4", roles: ["SuperAdmin"] });
  const tamperedRes = await app.inject({
    method: "GET",
    url: "/superadmin-only",
    headers: { authorization: `Bearer ${validToken.slice(0, -3)}xyz` },
  });
  assert.equal(tamperedRes.statusCode, 401);

  const unknownRoleToken = await signToken({ sub: "u5", roles: ["SomeOtherKeycloakClientRole"] });
  const unknownRoleRes = await app.inject({
    method: "GET",
    url: "/superadmin-only",
    headers: { authorization: `Bearer ${unknownRoleToken}` },
  });
  assert.equal(unknownRoleRes.statusCode, 401);
});

test("a token signed by a different keypair (not in the JWKS) is rejected", async (t) => {
  const { jwks } = await buildTestKeyMaterial();
  const app = await buildTestApp(jwks);
  t.after(() => app.close());

  const { signToken: signWithWrongKey } = await buildTestKeyMaterial();
  const forged = await signWithWrongKey({ sub: "attacker", roles: ["SuperAdmin"] });
  const res = await app.inject({ method: "GET", url: "/superadmin-only", headers: { authorization: `Bearer ${forged}` } });
  assert.equal(res.statusCode, 401);
});
