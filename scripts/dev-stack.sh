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
