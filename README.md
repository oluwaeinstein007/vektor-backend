# vektor-platform

All TypeScript apps and microservices for [VEKTOR](../vektor-docs/VEKTOR-PRD.md) — see PRD §9.2 and §9.6 for the full repository layout this maps to.

## Layout

```
apps/            Next.js web dashboard, field PWA, API gateway plugins   (Phase 1+, not yet scaffolded)
services/        ingest-svc, cv-inference-svc, fusion-svc, coa-svc, ...  (Phase 1+, not yet scaffolded)
packages/
  config/        Shared TypeScript, ESLint, and Prettier config
  shared/        Re-exports @vektor/proto — no service imports the contract repo directly
  db/            Drizzle ORM schema (PostgreSQL + PostGIS + TimescaleDB)
  kafka/         kafkajs client factory + topic-naming helper + re-exported event schemas
  ui/            Shared React components (shadcn/ui base)
```

`apps/` and `services/` are intentionally empty right now — this repo currently covers Phase 0 (INFRA-002: Turborepo + pnpm workspace init, shared package scaffolding). Each service/app is scaffolded by its own roadmap task (see `../vektor-docs/docs/09-roadmap.md`) as its Phase comes up.

## Local development

`@vektor/proto` is consumed from the filesystem until it's published to a real registry — build it first:

```bash
cd ../vektor-proto && pnpm build
cd ../vektor-platform && pnpm install
pnpm build
```

## Commands

```bash
pnpm install
pnpm build   # turbo run build, cached & parallel across the workspace
pnpm dev     # turbo run dev
pnpm lint    # turbo run lint (typecheck)
```
