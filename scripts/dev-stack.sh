#!/usr/bin/env bash
# NW-003: bring up the cloud-profile dev stack, wait for it to actually be
# ready, and apply migrations — the three steps that used to be six READMEs.
#
#   ./scripts/dev-stack.sh up          core services
#   ./scripts/dev-stack.sh up --full   + qdrant, routing/erp postgres, debezium
#   ./scripts/dev-stack.sh down        stop (add --volumes to wipe data)
#   ./scripts/dev-stack.sh status      what's up and healthy
#   ./scripts/dev-stack.sh token Commander   mint a real Keycloak token
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose/docker-compose.dev.yml)
KEYCLOAK_URL="http://localhost:18080"
REALM="vektor"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

wait_healthy() {
  # `docker compose up --wait` honours healthchecks, but services without
  # one (mosquitto, mediamtx) make it wait on nothing useful, so this polls
  # only the containers that declare a healthcheck.
  local deadline=$((SECONDS + 240))
  while (( SECONDS < deadline )); do
    local pending=""
    for c in $("${COMPOSE[@]}" ps --format '{{.Name}}' 2>/dev/null); do
      local health
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)
      case "$health" in
        healthy|none) ;;
        *) pending="$pending $c($health)" ;;
      esac
    done
    if [[ -z "$pending" ]]; then echo "all healthchecked containers are healthy"; return 0; fi
    echo "  waiting for:$pending"
    sleep 5
  done
  echo "timed out waiting for containers to become healthy" >&2
  "${COMPOSE[@]}" ps
  return 1
}

# logistics-svc's CDC path consumes `dev.vektor.erp.public.inventory`, which
# only exists once the Debezium connector is registered against Kafka
# Connect's REST API. That used to be a manual curl documented in
# compose/README.md, which meant logistics-svc could never pass from a cold
# `stack:up:full` — it would sit waiting for CDC events from a connector
# nobody had created. Registering it here makes `--full` actually complete.
register_debezium() {
  echo "==> registering the Debezium inventory connector"
  for _ in $(seq 1 30); do
    curl -fsS http://localhost:18083/connectors >/dev/null 2>&1 && break
    sleep 2
  done
  # erp-postgres can end up attached to no network at all if the compose
  # network was recreated between two `up` invocations — Debezium then fails
  # to resolve the hostname and the connector dies on "connection attempt
  # failed". Re-attaching is idempotent and cheap.
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' vektor-dev-erp-postgres 2>/dev/null | grep -q vektor-dev; then
    echo "    (re-attaching erp-postgres to the compose network)"
    docker network connect --alias erp-postgres vektor-dev_default vektor-dev-erp-postgres 2>/dev/null || true
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:18083/connectors \
    -H 'Content-Type: application/json' -d '{
      "name": "vektor-erp-inventory",
      "config": {
        "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
        "database.hostname": "erp-postgres", "database.port": "5432",
        "database.user": "postgres", "database.password": "vektor",
        "database.dbname": "erp", "topic.prefix": "dev.vektor.erp",
        "plugin.name": "pgoutput", "table.include.list": "public.inventory"
      }
    }' 2>/dev/null)
  case "$code" in
    201) echo "    connector created" ;;
    409) echo "    connector already exists" ;;
    *)   echo "    WARNING: connector registration returned HTTP $code — logistics-svc's CDC tests will not pass until this succeeds" ;;
  esac
}

cmd_up() {
  local profiles=()
  [[ "${1:-}" == "--full" ]] && profiles=(--profile full)
  echo "==> starting containers"
  "${COMPOSE[@]}" "${profiles[@]}" up -d
  echo "==> waiting for health"
  wait_healthy
  echo "==> applying migrations"
  # The vektor_app role migration 0007 grants to is created by
  # compose/postgres-init/01-vektor-app-role.sql on first init of the
  # volume — see that file for why it isn't in the migration chain.
  DATABASE_URL="postgres://postgres:vektor@localhost:15432/vektor" \
    pnpm --filter @vektor/db exec drizzle-kit migrate
  echo
  echo "stack is up:"
  echo "  postgres   postgres://postgres:vektor@localhost:15432/vektor"
  echo "  kafka      localhost:19092"
  echo "  redis      redis://localhost:16379"
  echo "  keycloak   $KEYCLOAK_URL  (admin/admin; realm '$REALM')"
  echo "  maildev    http://localhost:11080"
  echo "  mqtt       mqtt://localhost:11883"
  echo "  rtsp       rtsp://localhost:8554/<path>"
  if [[ "${profiles[0]:-}" == "--profile" ]]; then
    register_debezium
  fi
  echo
  echo "next: cp compose/.env.example .env && set -a && . ./.env && set +a"
  echo "      ./scripts/dev-stack.sh token Commander"
}

cmd_down() {
  if [[ "${1:-}" == "--volumes" ]]; then
    "${COMPOSE[@]}" --profile full down -v
  else
    "${COMPOSE[@]}" --profile full down
  fi
}

cmd_status() { "${COMPOSE[@]}" --profile full ps; }

cmd_token() {
  # Mints a real access token from the imported dev realm. Every user's
  # password equals their username (compose/keycloak/vektor-realm.json).
  local role="${1:-Commander}"
  local user="${role,,}"; user="${user// /-}"
  local token
  token=$(curl -fsS -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
    -d "client_id=vektor-web" -d "grant_type=password" \
    -d "username=$user" -d "password=$user" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
  echo "$token"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  status) cmd_status ;;
  token) shift; cmd_token "$@" ;;
  *) usage ;;
esac
