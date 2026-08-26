# vektor-backend

All TypeScript microservices and shared backend packages for [VEKTOR](../vektor-docs/VEKTOR-PRD.md) — see PRD §9.2 and §9.6 for the full repository layout this maps to. The frontend (`apps/web`, and eventually `apps/field-pwa`) lives in the sibling [`vektor-web`](../vektor-web) repo, which consumes `packages/shared` from here via a cross-repo `link:` dependency — see that package's `package.json`.

## Layout

```
services/        ingest-svc, geospatial-svc, map-tile-server, cv-inference-svc, fusion-svc,
                  coa-svc, audit-svc, alert-svc, logistics-svc, reporting-svc, edge-sync-svc
packages/
  config/        Shared TypeScript, ESLint, and Prettier config
  shared/        Re-exports @vektor/proto — no service imports the contract repo directly.
                 Also consumed cross-repo by vektor-web/apps/web via a link: dependency.
  db/            Drizzle ORM schema (PostgreSQL + PostGIS + TimescaleDB)
  kafka/         kafkajs client factory + topic-naming helper + re-exported event schemas
  redis/         Redis client factory (event-time watermark windows, BullMQ, etc.)
  qdrant/        BGE-M3 embeddings + Qdrant doctrine store
  auth/          Auth/session utilities
  load-test/     Load-testing scripts
```

## Local development

`@vektor/proto` is consumed from the filesystem until it's published to a real registry — build it first:

```bash
cd ../vektor-proto && pnpm build
cd ../vektor-backend && pnpm install
pnpm build
```

## Commands

```bash
pnpm install
pnpm build   # turbo run build, cached & parallel across the workspace
pnpm dev     # turbo run dev
pnpm lint    # turbo run lint (typecheck)
```
