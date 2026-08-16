#!/usr/bin/env bash

set -Eeuo pipefail

# Creates a dedicated Blaxel WebSocket GOST rendezvous. With Cloudflare
# Flexible SSL, the edge is WSS and this origin listener is plain WS.

GOST_BIN_PATH="${GOST_BIN_PATH:-/usr/local/bin/gost}"
GOST_BLAXEL_DOMAIN="${GOST_BLAXEL_DOMAIN:-tunnel.nodenesia.id}"
GOST_BLAXEL_LISTEN_PORT="${GOST_BLAXEL_LISTEN_PORT:-28444}"
GOST_BLAXEL_METRICS_PORT="${GOST_BLAXEL_METRICS_PORT:-9001}"
GOST_BLAXEL_WS_PATH="${GOST_BLAXEL_WS_PATH:-/ws}"
GOST_BLAXEL_ORIGIN_TRANSPORT="${GOST_BLAXEL_ORIGIN_TRANSPORT:-ws}"
GOST_BLAXEL_CERT_SOURCE="${GOST_BLAXEL_CERT_SOURCE:-/etc/letsencrypt/live/${GOST_BLAXEL_DOMAIN}/fullchain.pem}"
GOST_BLAXEL_KEY_SOURCE="${GOST_BLAXEL_KEY_SOURCE:-/etc/letsencrypt/live/${GOST_BLAXEL_DOMAIN}/privkey.pem}"
GOST_BLAXEL_RUNTIME_DIR="${GOST_BLAXEL_RUNTIME_DIR:-/etc/nova-gost-blaxel}"
GOST_BLAXEL_ENV_FILE="${GOST_BLAXEL_ENV_FILE:-/etc/nova-gost-blaxel.env}"
GOST_BLAXEL_START_PATH="${GOST_BLAXEL_START_PATH:-/usr/local/sbin/nova-gost-blaxel-start}"
GOST_BLAXEL_SERVICE_NAME="${GOST_BLAXEL_SERVICE_NAME:-nova-gost-blaxel}"

log() { printf '[nova-gost-blaxel] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || die 'Run as root: sudo bash scripts/install-gost-blaxel-wss-master.sh'
}

validate() {
  [[ -x "${GOST_BIN_PATH}" ]] || die "GOST binary is missing: ${GOST_BIN_PATH}. Run scripts/install-gost-master.sh first."
  [[ "${GOST_BLAXEL_DOMAIN}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$ ]] || die 'GOST_BLAXEL_DOMAIN must be a hostname'
  [[ "${GOST_BLAXEL_WS_PATH}" =~ ^/[A-Za-z0-9._~/-]{0,127}$ ]] || die 'GOST_BLAXEL_WS_PATH must be an absolute URL path'
  [[ "${GOST_BLAXEL_ORIGIN_TRANSPORT}" =~ ^(ws|wss)$ ]] || die 'GOST_BLAXEL_ORIGIN_TRANSPORT must be ws or wss'
  for key in GOST_BLAXEL_LISTEN_PORT GOST_BLAXEL_METRICS_PORT; do
    local value="${!key}"
    [[ "${value}" =~ ^[0-9]+$ ]] && (( value >= 1024 && value <= 65535 )) || die "${key} must be between 1024 and 65535"
  done
  (( GOST_BLAXEL_LISTEN_PORT != GOST_BLAXEL_METRICS_PORT )) || die 'WebSocket and metrics ports must differ'
  if [[ "${GOST_BLAXEL_ORIGIN_TRANSPORT}" == 'wss' ]]; then
    [[ -r "${GOST_BLAXEL_CERT_SOURCE}" ]] || die "Certificate is not readable: ${GOST_BLAXEL_CERT_SOURCE}"
    [[ -r "${GOST_BLAXEL_KEY_SOURCE}" ]] || die "Private key is not readable: ${GOST_BLAXEL_KEY_SOURCE}"
  fi
}

read_credentials() {
  if [[ -z "${GOST_BLAXEL_TUNNEL_USERNAME:-}" ]]; then read -r -p 'Dedicated Blaxel tunnel username: ' GOST_BLAXEL_TUNNEL_USERNAME; fi
  if [[ -z "${GOST_BLAXEL_TUNNEL_PASSWORD:-}" ]]; then read -r -s -p 'Dedicated Blaxel tunnel password: ' GOST_BLAXEL_TUNNEL_PASSWORD; printf '\n'; fi
  [[ "${GOST_BLAXEL_TUNNEL_USERNAME}" =~ ^[A-Za-z0-9._~-]+$ ]] || die 'Username contains unsupported characters'
  [[ "${GOST_BLAXEL_TUNNEL_PASSWORD}" =~ ^[A-Za-z0-9._~-]+$ ]] || die 'Password contains unsupported characters'
}

create_user() {
  id -u gost >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin gost
}

install_tls_material() {
  [[ "${GOST_BLAXEL_ORIGIN_TRANSPORT}" == 'wss' ]] || return 0
  install -d -o root -g gost -m 0750 "${GOST_BLAXEL_RUNTIME_DIR}"
  install -o root -g gost -m 0640 "${GOST_BLAXEL_CERT_SOURCE}" "${GOST_BLAXEL_RUNTIME_DIR}/fullchain.pem"
  install -o root -g gost -m 0640 "${GOST_BLAXEL_KEY_SOURCE}" "${GOST_BLAXEL_RUNTIME_DIR}/privkey.pem"
}

write_env() {
  umask 077
  {
    printf 'GOST_BLAXEL_TUNNEL_USERNAME=%s\n' "${GOST_BLAXEL_TUNNEL_USERNAME}"
    printf 'GOST_BLAXEL_TUNNEL_PASSWORD=%s\n' "${GOST_BLAXEL_TUNNEL_PASSWORD}"
    printf 'GOST_BLAXEL_LISTEN_PORT=%s\n' "${GOST_BLAXEL_LISTEN_PORT}"
    printf 'GOST_BLAXEL_METRICS_PORT=%s\n' "${GOST_BLAXEL_METRICS_PORT}"
    printf 'GOST_BLAXEL_WS_PATH=%s\n' "${GOST_BLAXEL_WS_PATH}"
    printf 'GOST_BLAXEL_ORIGIN_TRANSPORT=%s\n' "${GOST_BLAXEL_ORIGIN_TRANSPORT}"
  } > "${GOST_BLAXEL_ENV_FILE}"
  chown root:root "${GOST_BLAXEL_ENV_FILE}"
  chmod 0600 "${GOST_BLAXEL_ENV_FILE}"
}

write_wrapper() {
  {
    printf '%s\n' '#!/bin/sh' 'set -eu'
    printf '%s\n' ': "${GOST_BLAXEL_TUNNEL_USERNAME:?}"' ': "${GOST_BLAXEL_TUNNEL_PASSWORD:?}"' ': "${GOST_BLAXEL_LISTEN_PORT:?}"' ': "${GOST_BLAXEL_METRICS_PORT:?}"' ': "${GOST_BLAXEL_WS_PATH:?}"' ': "${GOST_BLAXEL_ORIGIN_TRANSPORT:?}"'
    printf '%s\n' 'query="bind=true&path=${GOST_BLAXEL_WS_PATH}"'
    printf '%s\n' "if [ \"\${GOST_BLAXEL_ORIGIN_TRANSPORT}\" = 'wss' ]; then query=\"\${query}&certFile=${GOST_BLAXEL_RUNTIME_DIR}/fullchain.pem&keyFile=${GOST_BLAXEL_RUNTIME_DIR}/privkey.pem\"; fi"
    printf 'exec %q -L="socks5+${GOST_BLAXEL_ORIGIN_TRANSPORT}://${GOST_BLAXEL_TUNNEL_USERNAME}:${GOST_BLAXEL_TUNNEL_PASSWORD}@:${GOST_BLAXEL_LISTEN_PORT}?${query}" -metrics="127.0.0.1:${GOST_BLAXEL_METRICS_PORT}"\n' "${GOST_BIN_PATH}"
  } > "${GOST_BLAXEL_START_PATH}"
  chown root:root "${GOST_BLAXEL_START_PATH}"
  chmod 0755 "${GOST_BLAXEL_START_PATH}"
}

write_service() {
  local unit="/etc/systemd/system/${GOST_BLAXEL_SERVICE_NAME}.service"
  {
    printf '%s\n' \
      '[Unit]' 'Description=Nodenesia Blaxel GOST WebSocket rendezvous' 'After=network-online.target' 'Wants=network-online.target' '' \
      '[Service]' 'Type=simple' 'User=gost' 'Group=gost' "EnvironmentFile=${GOST_BLAXEL_ENV_FILE}" "ExecStart=${GOST_BLAXEL_START_PATH}" \
      'Restart=always' 'RestartSec=2s' 'LimitNOFILE=262144' 'TasksMax=65535' 'NoNewPrivileges=true' 'PrivateTmp=true' 'ProtectHome=true' 'ProtectSystem=strict' 'ProtectKernelTunables=true' 'ProtectKernelModules=true' 'ProtectControlGroups=true' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' '' \
      '[Install]' 'WantedBy=multi-user.target'
  } > "${unit}"
  chmod 0644 "${unit}"
}

write_renew_hook() {
  [[ "${GOST_BLAXEL_ORIGIN_TRANSPORT}" == 'wss' ]] || return 0
  local hook='/etc/letsencrypt/renewal-hooks/deploy/nova-gost-blaxel-reload'
  install -d -m 0755 "$(dirname "${hook}")"
  {
    printf '%s\n' '#!/bin/sh' 'set -eu'
    printf 'install -o root -g gost -m 0640 %q %q\n' "${GOST_BLAXEL_CERT_SOURCE}" "${GOST_BLAXEL_RUNTIME_DIR}/fullchain.pem"
    printf 'install -o root -g gost -m 0640 %q %q\n' "${GOST_BLAXEL_KEY_SOURCE}" "${GOST_BLAXEL_RUNTIME_DIR}/privkey.pem"
    printf 'systemctl restart %q\n' "${GOST_BLAXEL_SERVICE_NAME}.service"
  } > "${hook}"
  chmod 0750 "${hook}"
}

start() {
  systemctl daemon-reload
  systemctl enable --now "${GOST_BLAXEL_SERVICE_NAME}.service"
  systemctl is-active --quiet "${GOST_BLAXEL_SERVICE_NAME}.service" || { systemctl status --no-pager --full "${GOST_BLAXEL_SERVICE_NAME}.service" || true; die 'Service did not start'; }
  log "${GOST_BLAXEL_ORIGIN_TRANSPORT^^} origin listener active on 0.0.0.0:${GOST_BLAXEL_LISTEN_PORT}${GOST_BLAXEL_WS_PATH}"
  log "Create a Cloudflare Origin Rule: ${GOST_BLAXEL_DOMAIN}:443 -> origin port ${GOST_BLAXEL_LISTEN_PORT}."
  [[ "${GOST_BLAXEL_ORIGIN_TRANSPORT}" == 'wss' ]] && log 'Use Cloudflare Full (strict).' || log 'Use Cloudflare Flexible: the Cloudflare-to-origin WebSocket leg is not encrypted.'
  log "Allow only Cloudflare IP ranges to TCP ${GOST_BLAXEL_LISTEN_PORT} in UFW/cloud security group. Do not open it publicly."
}

main() {
  require_root
  validate
  read_credentials
  create_user
  install_tls_material
  write_env
  write_wrapper
  write_service
  write_renew_hook
  start
}

main "$@"
