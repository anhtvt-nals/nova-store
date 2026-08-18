#!/usr/bin/env bash

# Deploy Nodenesia on an Ubuntu/Debian VPS. Run from the checked-out project:
#   DOMAIN=app.example.com CERTBOT_EMAIL=ops@example.com bash scripts/deploy-production.sh
# Optional: APP_DIR=/opt/nodenesia SERVICE_NAME=nodenesia-api DEPLOY_USER=ubuntu

set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-nodenesia-api}"
DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
API_PORT="${API_PORT:-3001}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE_USER="${SERVICE_USER:-${DEPLOY_USER:-${SUDO_USER:-root}}}"
DEFAULT_SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || printf '%s' "$SERVICE_USER")"
SERVICE_GROUP="${SERVICE_GROUP:-$DEFAULT_SERVICE_GROUP}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)"
NVM_DIR="${NVM_DIR:-${SERVICE_HOME:-${HOME}}/.nvm}"
NODE_BIN=""
NGINX_SITE="/etc/nginx/sites-available/${SERVICE_NAME}"

die() { printf '[nodenesia-deploy] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[nodenesia-deploy] %s\n' "$*"; }

[[ "$EUID" -eq 0 ]] || die 'Log in as root, then run: DOMAIN=... CERTBOT_EMAIL=... bash scripts/deploy-production.sh'
id "$SERVICE_USER" >/dev/null 2>&1 || die "SERVICE_USER=$SERVICE_USER does not exist"
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

resolve_node() {
  local installed_major
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || die "Node.js/npm were not found. Install with NVM first: nvm install ${NODE_MAJOR} && nvm alias default ${NODE_MAJOR}"
  installed_major="$(node -p 'process.versions.node.split(`.`)[0]')"
  [[ "$installed_major" =~ ^[0-9]+$ ]] && (( installed_major >= 20 )) || die "Node.js $(node --version) is too old; install Node.js ${NODE_MAJOR} using NVM"
  NODE_BIN="$(command -v node)"
  log "Using NVM Node.js $(node --version) and npm $(npm --version)"
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
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=API_PORT=${API_PORT}
ExecStart=${NODE_BIN} dist/server/main.js
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
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$APP_DIR/dist"
  # Nginx workers run as www-data and only need traversal on the project path
  # plus read access to the compiled public assets. Do not expose .env/source.
  chmod o+x "$(dirname "$APP_DIR")" "$APP_DIR" "$APP_DIR/dist" "$APP_DIR/dist/public"
  find "$APP_DIR/dist/public" -type d -exec chmod o+rx {} +
  find "$APP_DIR/dist/public" -type f -exec chmod o+r {} +
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
limit_req_zone \$binary_remote_addr zone=nodenesia_telegram_webhook:10m rate=5r/s;

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

    # Keep the secret path out of access logs and bound unauthenticated work
    # before it reaches Nest/PostgreSQL. Nest still verifies Telegram's secret
    # header and applies its own persistent limiter.
    location ^~ /api/telegram/webhook/ {
        access_log off;
        limit_req zone=nodenesia_telegram_webhook burst=20 nodelay;
        proxy_pass http://127.0.0.1:${API_PORT}/api/telegram/webhook/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
        proxy_buffering off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        # Overwrite rather than append so clients cannot inject a trusted
        # forwarding chain. Nest trusts only this loopback Nginx hop.
        proxy_set_header X-Forwarded-For \$remote_addr;
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
  resolve_node
  build_application
  write_service
  write_nginx
  issue_certificate
  log "Deployment completed: https://${DOMAIN}"
  log "Service logs: journalctl -u ${SERVICE_NAME} -f"
}

main "$@"
