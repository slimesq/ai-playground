#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-0voice-av-study-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT_INPUT="${PORT-}"
TRACKER_API_KEY_INPUT="${TRACKER_API_KEY-}"
DATA_ROOT_INPUT="${DATA_ROOT-}"
DB_PATH_INPUT="${DB_PATH-}"
BACKUP_DIR_INPUT="${BACKUP_DIR-}"
BACKUP_INTERVAL_MINUTES_INPUT="${BACKUP_INTERVAL_MINUTES-}"
BACKUP_RETENTION_INPUT="${BACKUP_RETENTION-}"

PORT="${PORT:-3000}"
TRACKER_API_KEY="${TRACKER_API_KEY:-}"
DATA_ROOT="${DATA_ROOT:-/var/lib/${APP_NAME}}"
DB_PATH="${DB_PATH:-${DATA_ROOT}/tracker.db}"
BACKUP_DIR="${BACKUP_DIR:-${DATA_ROOT}/backups}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES:-360}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"
PM2_APP_NAME="${PM2_APP_NAME:-${APP_NAME}}"
CLEAR_TRACKER_API_KEY="${CLEAR_TRACKER_API_KEY:-0}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

semver_ge() {
  local current="$1"
  local expected="$2"
  local IFS=.
  local -a a b
  read -r -a a <<<"$current"
  read -r -a b <<<"$expected"
  for i in 0 1 2; do
    local av="${a[i]:-0}"
    local bv="${b[i]:-0}"
    if (( av > bv )); then
      return 0
    fi
    if (( av < bv )); then
      return 1
    fi
  done
  return 0
}

ensure_node_version() {
  require_cmd node
  local version
  version="$(node -p "process.versions.node")"
  if ! semver_ge "$version" "22.16.0"; then
    fail "Node version must be >= 22.16.0, current: ${version}"
  fi
  log "Node version OK: ${version}"
}

mkdir_owned() {
  local target="$1"
  if mkdir -p "$target" 2>/dev/null; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$target"
    sudo chown -R "$(id -u):$(id -g)" "$target"
    return 0
  fi
  fail "cannot create directory: ${target}"
}

read_existing_env_value() {
  local key="$1"
  local env_file="$2"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

normalize_env_value() {
  local value="$1"
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value" | sed 's/\\"/"/g'
}

prefer_existing_if_unset() {
  local current_value="$1"
  local input_value="$2"
  local existing_value="$3"
  if [[ -n "$input_value" ]]; then
    printf '%s' "$current_value"
  elif [[ -n "$existing_value" ]]; then
    printf '%s' "$existing_value"
  else
    printf '%s' "$current_value"
  fi
}

dotenv_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_env_file() {
  local env_file="${PROJECT_DIR}/.env"
  local existing_port existing_key existing_db_path existing_backup_dir existing_backup_interval existing_backup_retention
  existing_port="$(normalize_env_value "$(read_existing_env_value PORT "$env_file")")"
  existing_key="$(normalize_env_value "$(read_existing_env_value TRACKER_API_KEY "$env_file")")"
  existing_db_path="$(normalize_env_value "$(read_existing_env_value DB_PATH "$env_file")")"
  existing_backup_dir="$(normalize_env_value "$(read_existing_env_value BACKUP_DIR "$env_file")")"
  existing_backup_interval="$(normalize_env_value "$(read_existing_env_value BACKUP_INTERVAL_MINUTES "$env_file")")"
  existing_backup_retention="$(normalize_env_value "$(read_existing_env_value BACKUP_RETENTION "$env_file")")"

  PORT="$(prefer_existing_if_unset "$PORT" "$PORT_INPUT" "$existing_port")"
  if [[ "$CLEAR_TRACKER_API_KEY" == "1" ]]; then
    TRACKER_API_KEY=""
  else
    TRACKER_API_KEY="$(prefer_existing_if_unset "$TRACKER_API_KEY" "$TRACKER_API_KEY_INPUT" "$existing_key")"
  fi
  if [[ -z "$DATA_ROOT_INPUT" && -z "$DB_PATH_INPUT" && -n "$existing_db_path" ]]; then
    DB_PATH="$existing_db_path"
  fi
  if [[ -z "$DATA_ROOT_INPUT" && -z "$BACKUP_DIR_INPUT" && -n "$existing_backup_dir" ]]; then
    BACKUP_DIR="$existing_backup_dir"
  fi
  BACKUP_INTERVAL_MINUTES="$(prefer_existing_if_unset "$BACKUP_INTERVAL_MINUTES" "$BACKUP_INTERVAL_MINUTES_INPUT" "$existing_backup_interval")"
  BACKUP_RETENTION="$(prefer_existing_if_unset "$BACKUP_RETENTION" "$BACKUP_RETENTION_INPUT" "$existing_backup_retention")"

  cat >"$env_file" <<EOF
PORT=$(dotenv_escape "$PORT")
TRACKER_API_KEY=$(dotenv_escape "$TRACKER_API_KEY")
DB_PATH=$(dotenv_escape "$DB_PATH")
BACKUP_DIR=$(dotenv_escape "$BACKUP_DIR")
BACKUP_INTERVAL_MINUTES=$(dotenv_escape "$BACKUP_INTERVAL_MINUTES")
BACKUP_RETENTION=$(dotenv_escape "$BACKUP_RETENTION")
EOF
  log "Wrote ${env_file}"
}

install_dependencies() {
  require_cmd npm
  cd "$PROJECT_DIR"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
}

ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  log "pm2 not found, installing globally..."
  if npm install -g pm2; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo npm install -g pm2
    return 0
  fi
  fail "failed to install pm2"
}

start_or_restart_pm2() {
  cd "$PROJECT_DIR"
  if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$PM2_APP_NAME" --update-env
  else
    pm2 start server.js --name "$PM2_APP_NAME" --update-env
  fi
  pm2 save
}

print_summary() {
  local effective_data_root
  effective_data_root="$(dirname "$DB_PATH")"
  cat <<EOF

[deploy] Done.
[deploy] Project dir : ${PROJECT_DIR}
[deploy] Data root   : ${effective_data_root}
[deploy] DB path     : ${DB_PATH}
[deploy] Backup dir  : ${BACKUP_DIR}
[deploy] Port        : ${PORT}
[deploy] PM2 app     : ${PM2_APP_NAME}

[deploy] Health check:
curl http://127.0.0.1:${PORT}/api/health

[deploy] If this is the first time you use pm2 on this server, run once:
pm2 startup

[deploy] To clear the sync key on a later deploy:
CLEAR_TRACKER_API_KEY=1 bash scripts/deploy.sh
EOF
}

main() {
  log "Project dir: ${PROJECT_DIR}"
  ensure_node_version
  write_env_file
  mkdir_owned "$(dirname "$DB_PATH")"
  mkdir_owned "$BACKUP_DIR"
  install_dependencies
  ensure_pm2
  start_or_restart_pm2
  print_summary
}

main "$@"
