#!/usr/bin/env bash
#
# `pnpm test:e2e` — zero-config end-to-end test runner.
#
# Default path: boots a throwaway `postgres:16` container, runs every
# package's vitest suite with GUARDDOG_E2E=1 + GUARDDOG_DATABASE_URL set,
# tears the container down on exit (success, failure, or Ctrl-C).
#
# Override path: if a `.env` file at the repo root sets
# GUARDDOG_DATABASE_URL, that URL wins and Docker is skipped — useful for
# pointing at a long-lived local Postgres, a local Supabase
# (`supabase start` → port 54322), or any other reachable instance.
#
# Hosted Supabase will NOT work here: the e2e suites CREATE/DROP roles
# (`app_user`, `app_system`) and call SET LOCAL ROLE, which the hosted
# `postgres` user lacks the privileges for. Use local Supabase or local
# Docker Postgres instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Load .env if present so a user-supplied GUARDDOG_DATABASE_URL wins over
# the Docker default. `set -a` auto-exports every variable assigned via
# `source` (POSIX-style env files only — no shell-expansion sugar).
if [ -f .env ]; then
  echo "→ loading .env from repo root"
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

CONTAINER_NAME="guarddog-e2e-pg-$$"
HOST_PORT="${GUARDDOG_E2E_PG_PORT:-54329}"
CLEANUP_NEEDED=0

cleanup() {
  local exit_code=$?
  if [ "$CLEANUP_NEEDED" = "1" ]; then
    echo ""
    echo "→ stopping postgres container ($CONTAINER_NAME)"
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if [ -z "${GUARDDOG_DATABASE_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: GUARDDOG_DATABASE_URL is not set and docker is not installed." >&2
    echo "  - install docker so this script can boot postgres automatically, OR" >&2
    echo "  - copy .env.example to .env and set GUARDDOG_DATABASE_URL to your own DB." >&2
    exit 1
  fi

  echo "→ booting postgres:16 (container=$CONTAINER_NAME port=$HOST_PORT)"
  docker run -d --rm --name "$CONTAINER_NAME" \
    -e POSTGRES_USER=guarddog \
    -e POSTGRES_PASSWORD=guarddog \
    -e POSTGRES_DB=guarddog_e2e \
    -p "$HOST_PORT:5432" \
    postgres:16 >/dev/null
  CLEANUP_NEEDED=1

  printf "→ waiting for postgres to be ready"
  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER_NAME" pg_isready -U guarddog -d guarddog_e2e >/dev/null 2>&1; then
      printf " ✓\n"
      break
    fi
    printf "."
    sleep 1
  done

  if ! docker exec "$CONTAINER_NAME" pg_isready -U guarddog -d guarddog_e2e >/dev/null 2>&1; then
    printf " ✗\n" >&2
    echo "error: postgres did not become ready within 30s" >&2
    exit 1
  fi

  export GUARDDOG_DATABASE_URL="postgresql://guarddog:guarddog@127.0.0.1:$HOST_PORT/guarddog_e2e"
else
  echo "→ using GUARDDOG_DATABASE_URL from environment (Docker skipped)"
fi

export GUARDDOG_E2E=1

echo "→ running e2e suites"
echo ""
pnpm -r run test
