# audit-svc

Phase 4, SVC-013 (partial): append-only audit event store, REQ-8.3. The only writer of the `audit_log` table — every other service calls `POST /api/v1/audit` rather than writing the table directly (coa-svc's approve/reject workflow is the first real caller).

## Endpoints

- `POST /api/v1/audit` — internal write endpoint, called by other services after an auditable action.
- `GET /api/v1/audit?actor_user_id=&action=&from=&to=&limit=` — `07-data-api.md` §13.1, SuperAdmin-scoped (RBAC enforcement is the gateway/auth-svc's job, not yet built).

## Scope notes

- **Genuinely append-only by omission, not by a DB grant**: this package's `src/db/queries.ts` exposes only `insertAuditEntry`/`listAuditEntries` — there is no update/delete query anywhere in the service (enforced in `tests/queries.test.ts`). A hard guarantee (REVOKE UPDATE/DELETE at the Postgres role level) is SEC-003's job.

## Local development

```bash
docker run -d --name vektor-postgis -e POSTGRES_PASSWORD=vektor -e POSTGRES_DB=vektor -p 5433:5432 postgis/postgis:16-3.4-alpine

pnpm build
DATABASE_URL=postgres://postgres:vektor@localhost:5433/vektor pnpm start
```
