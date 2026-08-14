#!/usr/bin/env bash

set -Eeuo pipefail

# Installs a standalone GOST v3 rendezvous service for Nova Store's E2B
# reverse tunnels. Run this script on the master VPS as root.

GOST_VERSION="${GOST_VERSION:-3.2.6}"
GOST_RENDEZVOUS_PORT="${GOST_RENDEZVOUS_PORT:-28443}"
GOST_TUNNEL_PORT_MIN="${GOST_TUNNEL_PORT_MIN:-30000}"
GOST_TUNNEL_PORT_MAX="${GOST_TUNNEL_PORT_MAX:-39999}"
GOST_TUNNEL_TRANSPORT="${GOST_TUNNEL_TRANSPORT:-tcp}"
GOST_METRICS_PORT="${GOST_METRICS_PORT:-9000}"
GOST_BIN_PATH="${GOST_BIN_PATH:-/usr/local/bin/gost}"
GOST_START_PATH="${GOST_START_PATH:-/usr/local/sbin/nova-gost-start}"
GOST_ENV_FILE="${GOST_ENV_FILE:-/etc/nova-gost.env}"
GOST_SERVICE_NAME="${GOST_SERVICE_NAME:-nova-gost}"
CONFIGURE_UFW="${CONFIGURE_UFW:-false}"

log() {
  printf '[nova-gost] %s\n' "$*"
}

die() {
  printf '[nova-gost] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run as root: sudo ./scripts/install-gost-master.sh"
  fi
}

validate_config() {
  [[ "${GOST_VERSION}" =~ ^3\.[0-9]+\.[0-9]+$ ]] || die "GOST_VERSION must be a stable v3 release such as 3.2.6"
  [[ "${GOST_TUNNEL_TRANSPORT}" =~ ^(tcp|ws|wss)$ ]] || die "GOST_TUNNEL_TRANSPORT must be tcp, ws, or wss"

  for port_name in GOST_RENDEZVOUS_PORT GOST_TUNNEL_PORT_MIN GOST_TUNNEL_PORT_MAX GOST_METRICS_PORT; do
    local port="${!port_name}"
    [[ "${port}" =~ ^[0-9]+$ ]] || die "${port_name} must be numeric"
    (( port >= 1024 && port <= 65535 )) || die "${port_name} must be between 1024 and 65535"
  done

  (( GOST_TUNNEL_PORT_MIN <= GOST_TUNNEL_PORT_MAX )) || die "Tunnel port range is invalid"
  if (( GOST_RENDEZVOUS_PORT >= GOST_TUNNEL_PORT_MIN && GOST_RENDEZVOUS_PORT <= GOST_TUNNEL_PORT_MAX )); then
    die "The rendezvous port must not overlap the public tunnel port range"
  fi
  (( GOST_METRICS_PORT != GOST_RENDEZVOUS_PORT )) || die "The metrics port must not match the rendezvous port"
}

read_credentials() {
  if [[ -z "${GOST_TUNNEL_USERNAME:-}" ]]; then
    read -r -p 'GOST tunnel username: ' GOST_TUNNEL_USERNAME
  fi
  if [[ -z "${GOST_TUNNEL_PASSWORD:-}" ]]; then
    read -r -s -p 'GOST tunnel password: ' GOST_TUNNEL_PASSWORD
    printf '\n'
  fi

  [[ -n "${GOST_TUNNEL_USERNAME}" ]] || die "Tunnel username cannot be empty"
  [[ -n "${GOST_TUNNEL_PASSWORD}" ]] || die "Tunnel password cannot be empty"

  # These values are embedded in a socks5:// URL. Restricting them to the
  # RFC 3986 unreserved set avoids ambiguous parsing and shell expansion.
  [[ "${GOST_TUNNEL_USERNAME}" =~ ^[A-Za-z0-9._~-]+$ ]] || die "Tunnel username may only contain letters, numbers, dot, underscore, tilde, or hyphen"
  [[ "${GOST_TUNNEL_PASSWORD}" =~ ^[A-Za-z0-9._~-]+$ ]] || die "Tunnel password may only contain letters, numbers, dot, underscore, tilde, or hyphen"
}

install_dependencies() {
  command -v apt-get >/dev/null 2>&1 || die "This installer currently supports Ubuntu/Debian (apt-get)"
  log "Installing required packages"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar
}

download_gost() (
  local machine asset temp_dir archive url
  machine="$(uname -m)"
  case "${machine}" in
    x86_64|amd64) asset="linux_amd64" ;;
    aarch64|arm64) asset="linux_arm64" ;;
    *) die "Unsupported CPU architecture: ${machine}" ;;
  esac

  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "${temp_dir}"' EXIT
  archive="${temp_dir}/gost.tar.gz"
  url="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_${asset}.tar.gz"

  log "Downloading GOST ${GOST_VERSION} for ${asset}"
  curl --fail --show-error --location --proto '=https' --tlsv1.2 --output "${archive}" "${url}"
  tar -xzf "${archive}" -C "${temp_dir}" gost
  install -o root -g root -m 0755 "${temp_dir}/gost" "${GOST_BIN_PATH}"
  "${GOST_BIN_PATH}" -V
)

create_service_account() {
  if ! id -u gost >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin gost
  fi
}

write_runtime_config() {
  log "Writing ${GOST_ENV_FILE}"
  umask 077
  {
    printf 'GOST_TUNNEL_USERNAME=%s\n' "${GOST_TUNNEL_USERNAME}"
    printf 'GOST_TUNNEL_PASSWORD=%s\n' "${GOST_TUNNEL_PASSWORD}"
    printf 'GOST_RENDEZVOUS_PORT=%s\n' "${GOST_RENDEZVOUS_PORT}"
    printf 'GOST_TUNNEL_TRANSPORT=%s\n' "${GOST_TUNNEL_TRANSPORT}"
    printf 'GOST_METRICS_PORT=%s\n' "${GOST_METRICS_PORT}"
  } > "${GOST_ENV_FILE}"
  chown root:root "${GOST_ENV_FILE}"
  chmod 0600 "${GOST_ENV_FILE}"
}

write_start_wrapper() {
  log "Writing ${GOST_START_PATH}"
  {
    printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      ": \"\${GOST_TUNNEL_USERNAME:?GOST_TUNNEL_USERNAME is required}\"" \
      ": \"\${GOST_TUNNEL_PASSWORD:?GOST_TUNNEL_PASSWORD is required}\"" \
      ": \"\${GOST_RENDEZVOUS_PORT:?GOST_RENDEZVOUS_PORT is required}\"" \
      ": \"\${GOST_TUNNEL_TRANSPORT:?GOST_TUNNEL_TRANSPORT is required}\"" \
      ": \"\${GOST_METRICS_PORT:?GOST_METRICS_PORT is required}\"" \
      'case "${GOST_TUNNEL_TRANSPORT}" in' \
      '  tcp) tunnel_scheme=socks5 ;;' \
      '  ws|wss) tunnel_scheme="socks5+${GOST_TUNNEL_TRANSPORT}" ;;' \
      '  *) echo "Unsupported GOST_TUNNEL_TRANSPORT=${GOST_TUNNEL_TRANSPORT}" >&2; exit 1 ;;' \
      'esac' \
      "exec ${GOST_BIN_PATH} -L=\"\${tunnel_scheme}://\${GOST_TUNNEL_USERNAME}:\${GOST_TUNNEL_PASSWORD}@:\${GOST_RENDEZVOUS_PORT}?bind=true\" -metrics=\"127.0.0.1:\${GOST_METRICS_PORT}\""
  } > "${GOST_START_PATH}"
  chown root:root "${GOST_START_PATH}"
  chmod 0755 "${GOST_START_PATH}"
}

write_systemd_service() {
  local service_file="/etc/systemd/system/${GOST_SERVICE_NAME}.service"
  log "Writing ${service_file}"
  {
    printf '%s\n' \
      '[Unit]' \
      'Description=Nova Store GOST reverse-tunnel rendezvous' \
      'After=network-online.target' \
      'Wants=network-online.target' \
      '' \
      '[Service]' \
      'Type=simple' \
      'User=gost' \
      'Group=gost' \
      "EnvironmentFile=${GOST_ENV_FILE}" \
      "ExecStart=${GOST_START_PATH}" \
      'Restart=always' \
      'RestartSec=2s' \
      'LimitNOFILE=262144' \
      'TasksMax=65535' \
      'NoNewPrivileges=true' \
      'PrivateTmp=true' \
      'ProtectHome=true' \
      'ProtectSystem=strict' \
      'ProtectKernelTunables=true' \
      'ProtectKernelModules=true' \
      'ProtectControlGroups=true' \
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
      '' \
      '[Install]' \
      'WantedBy=multi-user.target'
  } > "${service_file}"
  chmod 0644 "${service_file}"
}

configure_firewall() {
  if [[ "${CONFIGURE_UFW}" != "true" ]]; then
    log "UFW unchanged. Allow TCP ${GOST_RENDEZVOUS_PORT} and ${GOST_TUNNEL_PORT_MIN}:${GOST_TUNNEL_PORT_MAX} in the VPS firewall and cloud security group."
    return
  fi

  command -v ufw >/dev/null 2>&1 || die "CONFIGURE_UFW=true, but ufw is not installed"
  log "Adding UFW rules"
  ufw allow "${GOST_RENDEZVOUS_PORT}/tcp"
  ufw allow "${GOST_TUNNEL_PORT_MIN}:${GOST_TUNNEL_PORT_MAX}/tcp"
}

start_service() {
  systemctl daemon-reload
  systemctl enable --now "${GOST_SERVICE_NAME}.service"
  if ! systemctl is-active --quiet "${GOST_SERVICE_NAME}.service"; then
    systemctl status --no-pager --full "${GOST_SERVICE_NAME}.service" || true
    die "GOST service did not start"
  fi

  log "GOST v3 rendezvous is active on ${GOST_TUNNEL_TRANSPORT} port ${GOST_RENDEZVOUS_PORT}"
  log "Prometheus metrics are available locally on 127.0.0.1:${GOST_METRICS_PORT}/metrics"
  systemctl status --no-pager --full "${GOST_SERVICE_NAME}.service"
}

main() {
  require_root
  validate_config
  read_credentials
  install_dependencies
  download_gost
  create_service_account
  write_runtime_config
  write_start_wrapper
  write_systemd_service
  configure_firewall
  start_service

  log "Installation complete"
  log "Verify externally: nc -vz <MASTER_VPS_IP> ${GOST_RENDEZVOUS_PORT}"
  log "Follow logs: journalctl -u ${GOST_SERVICE_NAME} -f"
}

main "$@"
