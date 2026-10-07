#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用拥有 Nginx 配置权限的用户运行部署脚本。\n' >&2
  exit 1
fi
command -v node >/dev/null
command -v pm2 >/dev/null
command -v nginx >/dev/null
command -v curl >/dev/null
cd "$PROJECT_DIR"
npm run check
install -d -m 700 /var/lib/vocal-study-planner
pm2 startOrReload ecosystem.config.cjs --only vocal-study-planner --update-env
curl --fail --silent --show-error --max-time 5 --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:3010/api/health >/dev/null

snippet=/etc/nginx/ai-playground-paths.d/vocal-study-planner.conf
install -d /etc/nginx/ai-playground-paths.d
backup="$(mktemp)"
had_snippet=0
if [[ -f "$snippet" ]]; then cp "$snippet" "$backup"; had_snippet=1; fi
cat > "$snippet" <<'NGINX'
location = / {
    return 302 /vocal-study-planner/;
}

location = /vocal-study-planner {
    return 301 /vocal-study-planner/;
}

location = /favicon.ico {
    proxy_pass http://127.0.0.1:3010/favicon.ico;
    proxy_set_header Host $host;
}

location = /favicon.png {
    proxy_pass http://127.0.0.1:3010/favicon.png;
    proxy_set_header Host $host;
}

location /vocal-study-planner/ {
    proxy_pass http://127.0.0.1:3010/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
NGINX
if ! nginx -t; then
  if [[ "$had_snippet" -eq 1 ]]; then cp "$backup" "$snippet"; else rm -f "$snippet"; fi
  rm -f "$backup"
  exit 1
fi
rm -f "$backup"
systemctl reload nginx
pm2 save
printf '声乐练习室部署完成：/vocal-study-planner/\n'
