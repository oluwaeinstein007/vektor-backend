// NW-021. Against real Postgres, and — for promotion — against a real HTTP
// server standing in for cv-inference-svc's upload endpoint. A promotion
// test with a mocked fetch proves the happy path and nothing about the two
// failures that actually happen: the artifact not matching its hash, and
// the deployment rejecting the model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDb, type VektorDb } from "@vektor/db";
import {
  createTrainingJob,
  transitionJob,
  registerModelVersion,
  listModelVersions,
  getTrainingJob,
  canTransition,
  isTerminal,
  TrainingJobError,
} from "../src/lifecycle.js";
import { promoteModelVersion, retireModelVersion, sha256, PromotionError } from "../src/promote.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const ORG = "00000000-0000-0000-0000-000000000001";

let db: VektorDb;

async function cleanup(): Promise<void> {
  await db.$client`DELETE FROM model_versions WHERE org_id = ${ORG}`;
  await db.$client`DELETE FROM training_jobs WHERE org_id = ${ORG}`;
}

before(async () => {
  db = createDb(DATABASE_URL);
  await cleanup();
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await db.$client.end();
  }
});

function newJobInput(name = "gate-detector") {
  return {
    org_id: ORG,
    name,
    dataset_uri: "s3://customer-a/datasets/gate-v1",
    classes: ["forklift", "pallet"],
    requested_by: "operator-1",
  };
}

// -------------------------------------------------------------- lifecycle

test("the state machine permits only the transitions a real job can make", () => {
  assert.ok(canTransition("QUEUED", "TRAINING"));
  assert.ok(canTransition("TRAINING", "EXPORTING"));
  assert.ok(canTransition("EXPORTING", "SUCCEEDED"));

  // EXPORTING deliberately cannot be cancelled: the GPU hours are already
  // spent and the export takes seconds, so a cancel there wastes exactly
  // what it was meant to save.
  assert.ok(canTransition("TRAINING", "CANCELLED"));
  assert.ok(!canTransition("EXPORTING", "CANCELLED"));

  // Terminal means terminal. Without this, a stray late callback from a
  // worker that died hours ago can move a CANCELLED job to SUCCEEDED and
  // publish a model nobody asked for.
  for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    assert.ok(isTerminal(terminal));
    assert.ok(!canTransition(terminal, "TRAINING"));
    assert.ok(!canTransition(terminal, "SUCCEEDED"));
  }
  assert.ok(!canTransition("QUEUED", "SUCCEEDED"), "a job cannot succeed without training");
});

test("a job is created QUEUED and refuses a classless detector", async () => {
  const job = await createTrainingJob(db, newJobInput());
  assert.equal(job.state, "QUEUED");
  assert.deepEqual(job.classes, ["forklift", "pallet"]);
  assert.equal(job.error, null);

  await assert.rejects(() => createTrainingJob(db, { ...newJobInput(), classes: [] }), /classes/);
});

test("an illegal transition is refused at the database, not just in the type system", async () => {
  const job = await createTrainingJob(db, newJobInput());
  await assert.rejects(() => transitionJob(db, job.job_id, "SUCCEEDED"), TrainingJobError);
  const unchanged = await getTrainingJob(db, job.job_id);
  assert.equal(unchanged!.state, "QUEUED", "the refused transition left no trace");
});

test("a FAILED transition must carry a reason", async () => {
  const job = await createTrainingJob(db, newJobInput());
  // A failure with no reason is one nobody can act on, and the reason is
  // never easier to find than at the moment of failing.
  await assert.rejects(() => transitionJob(db, job.job_id, "FAILED"), /requires an error message/);

  const failed = await transitionJob(db, job.job_id, "FAILED", { error: "dataset had 0 labelled instances of pallet" });
  assert.equal(failed.state, "FAILED");
  assert.match(failed.error!, /0 labelled instances/);
});

test("the happy path runs QUEUED -> TRAINING -> EXPORTING -> SUCCEEDED and timestamps it", async () => {
  const job = await createTrainingJob(db, newJobInput());
  await transitionJob(db, job.job_id, "TRAINING");
  await transitionJob(db, job.job_id, "EXPORTING");
  const done = await transitionJob(db, job.job_id, "SUCCEEDED");
  assert.equal(done.state, "SUCCEEDED");

  const [row] = await db.$client<{ started_at: Date | null; finished_at: Date | null }[]>`
    SELECT started_at, finished_at FROM training_jobs WHERE job_id = ${job.job_id}
  `;
  assert.ok(row!.started_at, "started_at set on entering TRAINING");
  assert.ok(row!.finished_at, "finished_at set on reaching a terminal state");
});

test("a concurrent second transition loses rather than silently overwriting", async () => {
  const job = await createTrainingJob(db, newJobInput());
  // Two workers both reporting on the same job. The current state is part
  // of the UPDATE's WHERE, so exactly one wins.
  const results = await Promise.allSettled([
    transitionJob(db, job.job_id, "TRAINING"),
    transitionJob(db, job.job_id, "TRAINING"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one transition applied");
});

// ---------------------------------------------------------------- versions

test("a version can only be registered from EXPORTING or SUCCEEDED", async () => {
  const job = await createTrainingJob(db, newJobInput());
  const artifact = Buffer.from("fake onnx bytes");
  const input = {
    job_id: job.job_id,
    artifact_uri: "s3://models/v1.onnx",
    artifact_sha256: sha256(artifact),
    size_bytes: artifact.length,
  };
  await assert.rejects(() => registerModelVersion(db, input), /is QUEUED/);

  await transitionJob(db, job.job_id, "TRAINING");
  await transitionJob(db, job.job_id, "EXPORTING");
  const version = await registerModelVersion(db, input);
  assert.equal(version.version, 1, "versions start at 1 per organisation");
  // Classes come from the JOB, never the caller: letting a caller restate
  // them invites a mislabelled detector reporting "person" for vehicles.
  assert.deepEqual(version.classes, ["forklift", "pallet"]);
});

test("version numbers increment per organisation and reject a malformed hash", async () => {
  const job = await createTrainingJob(db, newJobInput("second"));
  await transitionJob(db, job.job_id, "TRAINING");
  await transitionJob(db, job.job_id, "EXPORTING");

  const artifact = Buffer.from("second model");
  const v2 = await registerModelVersion(db, {
    job_id: job.job_id,
    artifact_uri: "s3://models/v2.onnx",
    artifact_sha256: sha256(artifact),
    size_bytes: artifact.length,
    metrics: { map50_95: 0.71 },
  });
  assert.equal(v2.version, 2);

  await assert.rejects(
    () =>
      registerModelVersion(db, {
        job_id: job.job_id,
        artifact_uri: "s3://models/v3.onnx",
        artifact_sha256: "not-a-hash",
        size_bytes: 10,
      }),
    /sha256/,
  );

  const listed = await listModelVersions(db, ORG);
  assert.equal(listed[0]!.version, 2, "newest first");
});

// --------------------------------------------------------------- promotion

/** Stands in for cv-inference-svc's upload endpoint. */
async function startFakeInference(behaviour: { status: number; body?: string }) {
  const received: { auth?: string; bytes: number }[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received.push({ auth: req.headers.authorization, bytes: Buffer.concat(chunks).length });
      res.writeHead(behaviour.status, { "content-type": "application/json" });
      res.end(behaviour.body ?? JSON.stringify({ status: "ok", executionProvider: "cpu" }));
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function readyVersion(artifact: Buffer, name = "promo") {
  const job = await createTrainingJob(db, newJobInput(name));
  await transitionJob(db, job.job_id, "TRAINING");
  await transitionJob(db, job.job_id, "EXPORTING");
  const version = await registerModelVersion(db, {
    job_id: job.job_id,
    artifact_uri: `s3://models/${name}.onnx`,
    artifact_sha256: sha256(artifact),
    size_bytes: artifact.length,
  });
  await transitionJob(db, job.job_id, "SUCCEEDED");
  return version;
}

test("promotion uploads to a REAL endpoint and records the deployment only after it succeeds", async (t) => {
  const artifact = Buffer.from("onnx-model-bytes-aaa");
  const version = await readyVersion(artifact, "promo-ok");
  const fake = await startFakeInference({ status: 200 });
  t.after(() => fake.close());

  const result = await promoteModelVersion(
    db,
    version.version_id,
    { name: "site-3-edge", baseUrl: fake.baseUrl, token: "superadmin-token" },
    { fetchArtifact: async () => artifact },
  );

  assert.ok(result.deployed_to.includes("site-3-edge"));
  assert.equal(result.executionProvider, "cpu", "the deployment's answer is passed back");
  assert.equal(fake.received[0]!.auth, "Bearer superadmin-token", "the endpoint is SuperAdmin-gated");
  assert.ok(fake.received[0]!.bytes > artifact.length, "multipart body carried the artifact");
});

test("promotion REFUSES an artifact whose hash does not match the registry", async (t) => {
  // The registry's whole claim is that it can answer "is the model running
  // at site 3 the one we think we shipped". Uploading without comparing
  // the hash recorded at production time makes that claim worthless.
  const artifact = Buffer.from("the-real-model");
  const version = await readyVersion(artifact, "promo-hash");
  const fake = await startFakeInference({ status: 200 });
  t.after(() => fake.close());

  await assert.rejects(
    () =>
      promoteModelVersion(
        db,
        version.version_id,
        { name: "site-4", baseUrl: fake.baseUrl, token: "t" },
        { fetchArtifact: async () => Buffer.from("something-else-entirely") },
      ),
    /hash mismatch/,
  );
  assert.equal(fake.received.length, 0, "nothing was uploaded");

  const [row] = await db.$client<{ deployed_to: string[] }[]>`
    SELECT deployed_to FROM model_versions WHERE version_id = ${version.version_id}
  `;
  assert.deepEqual(row!.deployed_to, [], "and no deployment was recorded");
});

test("a deployment rejecting the model surfaces its reason verbatim, and records nothing", async (t) => {
  const artifact = Buffer.from("bad-opset-model");
  const version = await readyVersion(artifact, "promo-reject");
  const fake = await startFakeInference({
    status: 400,
    body: JSON.stringify({ error: "model failed to load: unsupported opset 19" }),
  });
  t.after(() => fake.close());

  await assert.rejects(
    () =>
      promoteModelVersion(
        db,
        version.version_id,
        { name: "site-5", baseUrl: fake.baseUrl, token: "t" },
        { fetchArtifact: async () => artifact },
      ),
    // "the promotion failed" is useless; "unsupported opset 19" is the
    // thing the operator can act on.
    /unsupported opset 19/,
  );

  const [row] = await db.$client<{ deployed_to: string[] }[]>`
    SELECT deployed_to FROM model_versions WHERE version_id = ${version.version_id}
  `;
  assert.deepEqual(row!.deployed_to, [], "a failed upload must not leave a claimed deployment behind");
});

test("an unreachable deployment is reported as unreachable, not as a bad model", async () => {
  const artifact = Buffer.from("fine-model");
  const version = await readyVersion(artifact, "promo-unreachable");
  await assert.rejects(
    () =>
      promoteModelVersion(
        db,
        version.version_id,
        // Port 1 is reserved and nothing listens on it.
        { name: "site-6", baseUrl: "http://127.0.0.1:1", token: "t" },
        { fetchArtifact: async () => artifact },
      ),
    /could not reach site-6/,
  );
});

test("promoting the same version twice does not duplicate the deployment entry", async (t) => {
  const artifact = Buffer.from("idempotent-model");
  const version = await readyVersion(artifact, "promo-twice");
  const fake = await startFakeInference({ status: 200 });
  t.after(() => fake.close());

  const target = { name: "site-7", baseUrl: fake.baseUrl, token: "t" };
  await promoteModelVersion(db, version.version_id, target, { fetchArtifact: async () => artifact });
  const second = await promoteModelVersion(db, version.version_id, target, { fetchArtifact: async () => artifact });
  assert.deepEqual(second.deployed_to, ["site-7"], "re-promotion is idempotent in the record");
});

test("a retired version cannot be promoted, and drops out of the active list", async (t) => {
  const artifact = Buffer.from("retired-model");
  const version = await readyVersion(artifact, "promo-retired");
  const fake = await startFakeInference({ status: 200 });
  t.after(() => fake.close());

  await retireModelVersion(db, version.version_id);

  // Retiring is a decision that this model should stop being used.
  // Promoting it again would quietly undo that decision.
  await assert.rejects(
    () =>
      promoteModelVersion(
        db,
        version.version_id,
        { name: "site-8", baseUrl: fake.baseUrl, token: "t" },
        { fetchArtifact: async () => artifact },
      ),
    PromotionError,
  );

  const active = await listModelVersions(db, ORG);
  assert.ok(!active.some((v) => v.version_id === version.version_id));

  // But the row survives: a model that was running when an incident
  // happened is evidence, and must still be producible afterwards.
  const [row] = await db.$client<{ retired_at: Date | null }[]>`
    SELECT retired_at FROM model_versions WHERE version_id = ${version.version_id}
  `;
  assert.ok(row!.retired_at, "retirement is a timestamp, not a delete");
});
