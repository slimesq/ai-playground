#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用拥有 Nginx 配置权限的用户运行部署脚本。\n' >&2
  exit 1
fi
for required_command in node npm pm2 nginx curl systemctl; do
  command -v "$required_command" >/dev/null
done

cd "$PROJECT_DIR"
npm run check
install -d -m 700 /var/lib/rehab-study-tracker
pm2 startOrReload ecosystem.config.cjs --only rehab-study-tracker --update-env

healthy=0
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3011/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  printf '训练手记健康检查失败，请检查 pm2 logs rehab-study-tracker。\n' >&2
  exit 1
fi

snippet=/etc/nginx/ai-playground-paths.d/rehab-study-tracker.conf
install -d /etc/nginx/ai-playground-paths.d
backup="$(mktemp)"
had_snippet=0
snippet_changed=0
if [[ -f "$snippet" ]]; then
  cp -p "$snippet" "$backup"
  had_snippet=1
fi

restore_snippet() {
  if [[ "$had_snippet" -eq 1 ]]; then
    cp -p "$backup" "$snippet"
  else
    rm -f "$snippet"
  fi
}

cleanup() {
  if [[ "$snippet_changed" -eq 1 ]]; then
    restore_snippet
  fi
  rm -f "$backup"
}
trap cleanup EXIT

snippet_changed=1
cat > "$snippet" <<'NGINX'
location = /rehab-study-tracker {
    return 301 /rehab-study-tracker/;
}

location /rehab-study-tracker/ {
    proxy_pass http://127.0.0.1:3011/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
NGINX
chmod 644 "$snippet"

if ! nginx -t; then
  printf 'Nginx 配置检查失败，已恢复原有训练手记配置。\n' >&2
  exit 1
fi
if ! systemctl reload nginx; then
  restore_snippet
  snippet_changed=0
  if nginx -t; then
    systemctl reload nginx || true
  fi
  printf 'Nginx 重载失败，已恢复原有训练手记配置。\n' >&2
  exit 1
fi
snippet_changed=0
pm2 save
printf '训练手记部署完成：/rehab-study-tracker/\n'
