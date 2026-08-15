#!/usr/bin/env bash

# Deploy Nodenesia on an Ubuntu/Debian VPS. Run from the checked-out project:
#   sudo DOMAIN=app.example.com CERTBOT_EMAIL=ops@example.com ./scripts/deploy-production.sh
# Optional: APP_DIR=/opt/nodenesia SERVICE_NAME=nodenesia-api

set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-nodenesia-api}"
DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
API_PORT="${API_PORT:-3001}"
NGINX_SITE="/etc/nginx/sites-available/${SERVICE_NAME}"

die() { printf '[nodenesia-deploy] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[nodenesia-deploy] %s\n' "$*"; }

[[ "$EUID" -eq 0 ]] || die 'Run as root (for example: sudo DOMAIN=... CERTBOT_EMAIL=... ./scripts/deploy-production.sh)'
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ && "$DOMAIN" == *.* ]] || die 'DOMAIN must be a valid hostname, for example app.example.com'
[[ "$CERTBOT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die 'CERTBOT_EMAIL must be a valid email address'
[[ -f "$APP_DIR/package.json" ]] || die "package.json was not found in APP_DIR=$APP_DIR"
[[ -f "$APP_DIR/.env" ]] || die "Create $APP_DIR/.env before deploying; do not put its secrets in this script"
[[ "$API_PORT" =~ ^[0-9]+$ && "$API_PORT" -ge 1024 && "$API_PORT" -le 65535 ]] || die 'API_PORT must be a valid unprivileged TCP port'

install_packages() {
  command -v apt-get >/dev/null 2>&1 || die 'This deployment script supports Ubuntu/Debian hosts using apt-get'
  log 'Installing Nginx, Certbot, and build dependencies'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx ca-certificates curl
}

build_application() {
  log 'Installing locked Node dependencies and building production assets'
  command -v npm >/dev/null 2>&1 || die 'Node.js and npm must be installed before deployment'
  cd "$APP_DIR"
  if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
  npm run build
  [[ -f "$APP_DIR/dist/server/main.js" ]] || die 'Nest production build was not created'
  [[ -f "$APP_DIR/dist/public/index.html" ]] || die 'Vite production build was not created'
}

write_service() {
  log "Writing systemd service ${SERVICE_NAME}"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Nodenesia Nest API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=API_PORT=${API_PORT}
ExecStart=/usr/bin/env node dist/server/main.js
Restart=always
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
# The project can be deployed from /home/<user>/nova-store as well as /opt.
# Read-only access is required for WorkingDirectory and the compiled assets.
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF
  chown -R www-data:www-data "$APP_DIR/dist"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"
  systemctl is-active --quiet "${SERVICE_NAME}.service" || {
    journalctl -u "${SERVICE_NAME}.service" --no-pager -n 100 || true
    die 'API service did not start'
  }
}

write_nginx() {
  log "Writing Nginx virtual host for ${DOMAIN}"
  cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    root ${APP_DIR}/dist/public;
    index index.html;

    client_max_body_size 2m;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
        proxy_buffering off;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
}

issue_certificate() {
  log "Requesting/renewing Let's Encrypt certificate for ${DOMAIN}"
  certbot --nginx --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --redirect -d "$DOMAIN"
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
}

main() {
  install_packages
  build_application
  write_service
  write_nginx
  issue_certificate
  log "Deployment completed: https://${DOMAIN}"
  log "Service logs: journalctl -u ${SERVICE_NAME} -f"
}

main "$@"
