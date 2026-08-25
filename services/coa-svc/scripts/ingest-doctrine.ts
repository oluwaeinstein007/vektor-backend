// ML-008 ingestion CLI — chunks and embeds every doctrine/*.md file into
// Qdrant. Run from services/coa-svc: `pnpm ingest-doctrine`. Idempotent
// (ingestDoctrineDocument deletes a source's old chunks before inserting
// its new ones), so safe to re-run after editing a doctrine file.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createQdrantClient, ensureDoctrineCollection, ingestDoctrineDocument } from "@vektor/qdrant";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
// tsc only emits compiled .ts->.js into dist/ — doctrine/*.md never gets
// copied there, so this has to walk back up from dist/scripts/ to the
// package root (two levels) and into the real source-tree doctrine/
// directory, not a sibling of the compiled file. Same pitfall as
// cv-inference-svc's fixture-path handling (see vektor-build-conventions).
const DOCTRINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "doctrine");

async function main(): Promise<void> {
  const client = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(client);

  const files = (await readdir(DOCTRINE_DIR)).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.warn(`no .md files found in ${DOCTRINE_DIR}`);
    return;
  }

  for (const file of files) {
    const text = await readFile(join(DOCTRINE_DIR, file), "utf-8");
    const count = await ingestDoctrineDocument(client, file, text);
    console.log(`ingested ${file}: ${count} chunks`);
  }
}

main().catch((err: unknown) => {
  console.error("doctrine ingestion failed", err);
  process.exit(1);
});
