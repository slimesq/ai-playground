#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-0voice-av-study-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SITE_NAME="${SITE_NAME:-${APP_NAME}}"
DOMAIN="${DOMAIN:-_}"
EXPOSE_MODE="${EXPOSE_MODE:-path}"
PATH_PREFIX="${PATH_PREFIX:-/0voice-av-study-tracker}"
PATH_GATEWAY_SITE="${PATH_GATEWAY_SITE:-ai-playground-paths}"
PATH_INCLUDE_DIR="${PATH_INCLUDE_DIR:-/etc/nginx/ai-playground-paths.d}"

log() {
  printf '[deploy-full] %s\n' "$*"
}

fail() {
  printf '[deploy-full] ERROR: %s\n' "$*" >&2
  exit 1
}

run_root_cmd() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return 0
  fi
  fail "this step needs root privileges: $*"
}

read_env_value() {
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

install_nginx_if_needed() {
  if command -v nginx >/dev/null 2>&1; then
    log "nginx already installed"
    return 0
  fi

  log "installing nginx..."
  run_root_cmd apt-get update
  run_root_cmd apt-get install -y nginx
}

normalize_path_prefix() {
  local prefix="$1"
  if [[ -z "$prefix" || "$prefix" == "/" ]]; then
    fail "PATH_PREFIX must not be empty or / when EXPOSE_MODE=path"
  fi

  if [[ "${prefix}" != /* ]]; then
    prefix="/${prefix}"
  fi

  prefix="${prefix%/}"
  printf '%s' "$prefix"
}

load_app_port() {
  local env_file="${PROJECT_DIR}/.env"
  local raw_port
  raw_port="$(normalize_env_value "$(read_env_value PORT "$env_file")")"
  printf '%s' "${raw_port:-3000}"
}

configure_nginx_subdomain() {
  local app_port nginx_config
  app_port="$(load_app_port)"
  nginx_config="/etc/nginx/sites-available/${SITE_NAME}"

  log "writing nginx config for ${DOMAIN} -> 127.0.0.1:${app_port}"
  local tmpfile
  tmpfile="$(mktemp)"
  cat >"$tmpfile" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${app_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  run_root_cmd cp "$tmpfile" "$nginx_config"
  rm -f "$tmpfile"
  run_root_cmd ln -sf "$nginx_config" "/etc/nginx/sites-enabled/${SITE_NAME}"
  run_root_cmd rm -f /etc/nginx/sites-enabled/default
  run_root_cmd nginx -t
  run_root_cmd systemctl enable nginx
  if ! run_root_cmd systemctl reload nginx; then
    run_root_cmd systemctl restart nginx
  fi
}

configure_nginx_path() {
  local app_port prefix gateway_config snippet_config tmpfile
  app_port="$(load_app_port)"
  prefix="$(normalize_path_prefix "$PATH_PREFIX")"
  gateway_config="/etc/nginx/sites-available/${PATH_GATEWAY_SITE}"
  snippet_config="${PATH_INCLUDE_DIR}/${SITE_NAME}.conf"

  log "writing nginx path mapping ${DOMAIN}${prefix}/ -> 127.0.0.1:${app_port}"
  run_root_cmd mkdir -p "$PATH_INCLUDE_DIR"

  tmpfile="$(mktemp)"
  cat >"$tmpfile" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    include ${PATH_INCLUDE_DIR}/*.conf;
}
EOF
  run_root_cmd cp "$tmpfile" "$gateway_config"

  cat >"$tmpfile" <<EOF
location = ${prefix} {
    return 301 ${prefix}/;
}

location ${prefix}/ {
    proxy_pass http://127.0.0.1:${app_port}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
EOF
  run_root_cmd cp "$tmpfile" "$snippet_config"
  rm -f "$tmpfile"

  run_root_cmd ln -sf "$gateway_config" "/etc/nginx/sites-enabled/${PATH_GATEWAY_SITE}"
  run_root_cmd rm -f /etc/nginx/sites-enabled/default
  run_root_cmd nginx -t
  run_root_cmd systemctl enable nginx
  if ! run_root_cmd systemctl reload nginx; then
    run_root_cmd systemctl restart nginx
  fi
}

configure_nginx() {
  case "$EXPOSE_MODE" in
    subdomain)
      configure_nginx_subdomain
      ;;
    path)
      configure_nginx_path
      ;;
    *)
      fail "EXPOSE_MODE must be subdomain or path"
      ;;
  esac
}

print_summary() {
  local app_port browser_url shown_site_name
  app_port="$(load_app_port)"
  shown_site_name="${SITE_NAME}"
  if [[ "$EXPOSE_MODE" == "path" ]]; then
    local prefix
    prefix="$(normalize_path_prefix "$PATH_PREFIX")"
    shown_site_name="${PATH_GATEWAY_SITE}"
    if [[ "${DOMAIN}" == "_" ]]; then
      browser_url="http://your-server-ip${prefix}/"
    else
      browser_url="http://${DOMAIN}${prefix}/"
    fi
  else
    if [[ "${DOMAIN}" == "_" ]]; then
      browser_url="http://your-server-ip"
    else
      browser_url="http://${DOMAIN}"
    fi
  fi
  cat <<EOF

[deploy-full] Done.
[deploy-full] App dir      : ${PROJECT_DIR}
[deploy-full] Expose mode  : ${EXPOSE_MODE}
[deploy-full] Server name  : ${DOMAIN}
[deploy-full] App port     : ${app_port}
[deploy-full] Nginx site   : ${shown_site_name}

[deploy-full] Check locally:
curl --noproxy '*' http://127.0.0.1

[deploy-full] Browser:
${browser_url}

[deploy-full] Remember:
- open TCP/80 in your Alibaba Cloud security group
- run 'pm2 startup' once if you have not enabled boot startup yet
EOF
}

main() {
  log "project dir: ${PROJECT_DIR}"
  bash "${SCRIPT_DIR}/deploy.sh"
  install_nginx_if_needed
  configure_nginx
  print_summary
}

main "$@"
