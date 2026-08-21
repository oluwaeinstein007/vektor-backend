# geospatial-svc

SVC-005: PostGIS CRUD + spatial query API. Owns `/api/v1/entities` (§13.1) — list (paginated, filterable by class/affiliation/bbox), detail, and operator tagging.

## Local development

Needs a real PostgreSQL+PostGIS instance — the bbox filter is a real `ST_Contains` query, not something worth mocking:

```bash
docker run -d --name vektor-dev-postgis -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=vektor -p 5432:5432 postgis/postgis:16-3.4-alpine

cd ../../packages/db
DATABASE_URL=postgres://postgres:dev@localhost:5432/vektor pnpm exec drizzle-kit generate --config=drizzle.config.ts
docker exec -i vektor-dev-postgis psql -U postgres -d vektor < migrations/<latest>.sql

cd ../../services/geospatial-svc
pnpm build
DATABASE_URL=postgres://postgres:dev@localhost:5432/vektor pnpm start
```

Tests need the same `DATABASE_URL` — `tests/app.test.ts` truncates the `entities` table between cases, so point it at a disposable database, never anything with real data.

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5432/vektor pnpm build && node --test dist/tests/*.test.js
```
