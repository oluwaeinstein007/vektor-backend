# Local dev stack (cloud profile)

One command brings up everything the TypeScript services need. The services
themselves run on your host under `pnpm dev`, so you keep hot reload —
container images for them exist too (see `services/DOCKERFILES.md`), but you
don't want to rebuild an image on every edit.

```sh
pnpm stack:up            # core: postgis, kafka, redis, keycloak, maildev, mosquitto, mediamtx
pnpm stack:up:full       # + qdrant, routing-postgres, erp-postgres, debezium
pnpm stack:status
pnpm stack:down          # add --volumes to wipe the data too
```

`stack:up` starts the containers, waits for every healthcheck, and applies
the Drizzle migrations. Then:

```sh
cp compose/.env.example .env
set -a && . ./.env && set +a
pnpm --filter @vektor/fusion-svc dev
```

## Endpoints

| What | Where |
|---|---|
| Postgres + PostGIS | `postgres://postgres:vektor@localhost:15432/vektor` |
| Kafka | `localhost:19092` |
| Redis | `redis://localhost:16379` |
| Keycloak | <http://localhost:18080> — admin `admin`/`admin`, realm `vektor` |
| Maildev (sent mail) | <http://localhost:11080> |
| MQTT | `mqtt://localhost:11883` |
| RTSP | `rtsp://localhost:8554/<path>` |
| Qdrant (`--full`) | <http://localhost:16333> |
| pgRouting (`--full`) | `postgres://postgres:vektor@localhost:15434/vektor_routing` |
| ERP stand-in (`--full`) | `postgres://postgres:vektor@localhost:15433/erp` |
| Kafka Connect (`--full`) | <http://localhost:18083> |

### Why these ports and not the ones in the service READMEs

Every port the service READMEs document — 5432, 5433, 6379, 3000-3002 — was
already taken by unrelated projects on the machine this stack was built on.
That is the collision `16-system-status.md` warns about, and it is the normal
case on a shared dev box, not bad luck. The ports above are deliberately
improbable. `16379`, `19092` and `11883` match what `.github/workflows/ci.yml`
already uses, so CI and local dev agree.

## Auth

The stack runs a **real Keycloak** with the `vektor` realm imported from
`keycloak/vektor-realm.json`: the six §5.1 RBAC roles, and one user per role
whose password equals their username.

```sh
pnpm stack:token Commander     # prints a real access token
curl -H "Authorization: Bearer $(pnpm -s stack:token Analyst)" \
  http://localhost:3007/api/v1/no-strike-zones
```

`packages/auth`'s `dev:auth-bridge` still exists and is still useful for an
even lighter loop (no Keycloak container), but it carries a loud "never point
a real deployment at this" warning for good reason. The compose stack gives
you the real thing instead.

**`KEYCLOAK_AUDIENCE` is deliberately unset** in `.env.example`. Keycloak puts
the client id in `azp`, not `aud`, for a public client's access token, so
setting an audience rejects every token this realm issues.

## Things that broke while building this, and what fixed them

Each of these was a real failure reproduced here, not a precaution.

**Migration 0007 grants to a role nothing creates.**
`packages/db/migrations/0007_whole_alice.sql` does
`GRANT SELECT, INSERT ON "audit_log" TO "vektor_app"`, and no migration ever
creates `vektor_app` — the only thing that did was `packages/db/tests/rls.test.ts`,
at test time. `drizzle-kit migrate` against a genuinely fresh Postgres failed
with `role "vektor_app" does not exist`. Fixed by
`postgres-init/01-vektor-app-role.sql`, which the entrypoint runs on first
init of the data volume.

**Mounting `postgres-init` as a directory silently disabled PostGIS.**
Bind-mounting `./postgres-init` over `/docker-entrypoint-initdb.d` shadows the
postgis image's own `10_postgis.sh`, so the extension was never created and
migration 0000 died with `type "geometry" does not exist`. The compose file
mounts the single `.sql` file into that directory instead, leaving the image's
scripts in place.

**Keycloak rejected every imported user with "Account is not fully set up".**
Two separate causes, stacked:

1. A realm import *replaces* a user's realm-role set, so listing only
   `["Commander"]` left the account without the realm's own
   `default-roles-vektor` composite. Every user now lists it explicitly.
2. The users had `lastName: "(dev)"`. Keycloak's default declarative user
   profile applies a `person-name-prohibited-characters` validator to
   `firstName`/`lastName`, and **parentheses are prohibited**. That triggers
   `VERIFY_PROFILE` *dynamically* — so the admin API reports
   `requiredActions: []` while every password grant still fails with
   `error="resolve_required_actions"`. Renaming to `Dev` fixed it.

   This one is worth remembering: the error message names required actions,
   the stored required actions are empty, and the actual cause is a character
   in a name field.

## Publishing an RTSP test stream

`ingest-svc`'s RTSP adapter needs something actually arriving at MediaMTX:

```sh
ffmpeg -stream_loop -1 -re -f lavfi -i testsrc=size=320x240:rate=15 \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/testcam
```

`-rtsp_transport tcp` is not optional — UDP RTSP sessions time out across a
bridged Docker network.

## IPv6 with no default route

If `ip -6 route show default` prints nothing, this machine has no IPv6
route while DNS still hands back AAAA records, so anything reaching a CDN
fails instantly instead of falling back to IPv4. `.env.example` sets
`NODE_OPTIONS=--dns-result-order=ipv4first`, which fixes the routing half.
It is not a complete fix — a large download can still die mid-transfer with
`UND_ERR_SOCKET` — but it turns a hard failure into a retryable one. This
is the single cause behind three separate symptoms seen here: an apt mirror
failure building `reporting-svc`, a Docker Hub TLS timeout pulling
`pgrouting`, and `@vektor/qdrant`'s BGE-M3 fetch.

## The Debezium connector (`--full`)

`./scripts/dev-stack.sh up --full` now registers this automatically — it
used to be a manual step, which meant `logistics-svc` could never pass from
a cold start because it waited on CDC events from a connector nobody had
created. The script also re-attaches `erp-postgres` to the compose network
first: it can end up attached to no network at all if the network was
recreated between two `up` invocations, and Debezium then fails to resolve
the hostname.

The equivalent by hand, if you need it:

```sh
curl -X POST http://localhost:18083/connectors -H 'Content-Type: application/json' -d '{
  "name": "vektor-erp-inventory",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "erp-postgres", "database.port": "5432",
    "database.user": "postgres", "database.password": "vektor",
    "database.dbname": "erp", "topic.prefix": "dev.vektor.erp",
    "plugin.name": "pgoutput", "table.include.list": "public.inventory"
  }
}'
```

That produces on `dev.vektor.erp.public.inventory`, which
`logistics-svc/src/cdc/inventoryConsumer.ts` consumes.

## What this stack is not

- It does not run the TS services. `services/DOCKERFILES.md` covers the
  images; a `docker-compose.full.yml` layering them on top is worth adding
  once `release-images.yml` has published a set.
- It is a **development** stack. Every credential here is public, Keycloak
  runs in `start-dev` mode with an in-memory database, and the MQTT broker
  allows anonymous connections.
