#!/usr/bin/env bash
set -euo pipefail

: "${STATIC_GOST_VERSION:=3.3.0}"
: "${STATIC_GOST_API_ADDR:=127.0.0.1:18081}"
: "${STATIC_GOST_SERVICE_USER:=nodenesia-gost}"
: "${STATIC_GOST_BANDWIDTH_PER_PORT:=50MB}"
: "${STATIC_GOST_BANDWIDTH_PER_CONNECTION:=10MB}"
: "${STATIC_GOST_MAX_CONNECTIONS_PER_PORT:=150}"
: "${STATIC_GOST_MAX_CONNECTIONS_PER_IP:=20}"
: "${STATIC_GOST_REQUESTS_PER_SECOND_PER_PORT:=100}"
: "${STATIC_GOST_REQUESTS_PER_SECOND_PER_IP:=20}"

if [[ "${EUID}" -ne 0 ]]; then
  echo '[static-gost] Run with sudo/root.' >&2
  exit 1
fi
if ! [[ "$STATIC_GOST_VERSION" =~ ^3\.[3-9]\.[0-9]+$ ]]; then
  echo '[static-gost] STATIC_GOST_VERSION must be v3.3.0 or newer for quota support.' >&2
  exit 1
fi
if ! [[ "$STATIC_GOST_API_ADDR" =~ ^127\.0\.0\.1:[0-9]{2,5}$ ]]; then
  echo '[static-gost] STATIC_GOST_API_ADDR must be IPv4 loopback, for example 127.0.0.1:18081.' >&2
  exit 1
fi
for value in "$STATIC_GOST_MAX_CONNECTIONS_PER_PORT" "$STATIC_GOST_MAX_CONNECTIONS_PER_IP" "$STATIC_GOST_REQUESTS_PER_SECOND_PER_PORT" "$STATIC_GOST_REQUESTS_PER_SECOND_PER_IP"; do
  [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || { echo '[static-gost] static connection/request limits must be positive integers.' >&2; exit 1; }
done

asset="gost_${STATIC_GOST_VERSION}_linux_amd64.tar.gz"
url="https://github.com/go-gost/gost/releases/download/v${STATIC_GOST_VERSION}/${asset}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$url" -o "$tmpdir/gost.tgz"
tar -xzf "$tmpdir/gost.tgz" -C "$tmpdir" gost
install -m 0755 "$tmpdir/gost" /usr/local/bin/gost-static
id -u "$STATIC_GOST_SERVICE_USER" >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin "$STATIC_GOST_SERVICE_USER"
install -d -o "$STATIC_GOST_SERVICE_USER" -g "$STATIC_GOST_SERVICE_USER" -m 0750 /etc/nodenesia-static-gost
install -d -o "$STATIC_GOST_SERVICE_USER" -g "$STATIC_GOST_SERVICE_USER" -m 0750 /var/lib/nodenesia-static-gost
dollar='$'
cat >/etc/nodenesia-static-gost/gost.json <<EOF
{
  "services": [],
  "limiters": [{"name":"static-bandwidth","limits":["${dollar} ${STATIC_GOST_BANDWIDTH_PER_PORT} ${STATIC_GOST_BANDWIDTH_PER_PORT}","${dollar}${dollar} ${STATIC_GOST_BANDWIDTH_PER_CONNECTION} ${STATIC_GOST_BANDWIDTH_PER_CONNECTION}"]}],
  "climiters": [{"name":"static-connections","limits":["${dollar} ${STATIC_GOST_MAX_CONNECTIONS_PER_PORT}","${dollar}${dollar} ${STATIC_GOST_MAX_CONNECTIONS_PER_IP}"]}],
  "rlimiters": [{"name":"static-requests","limits":["${dollar} ${STATIC_GOST_REQUESTS_PER_SECOND_PER_PORT}","${dollar}${dollar} ${STATIC_GOST_REQUESTS_PER_SECOND_PER_IP}"]}]
}
EOF
chown "$STATIC_GOST_SERVICE_USER:$STATIC_GOST_SERVICE_USER" /etc/nodenesia-static-gost/gost.json
chmod 0640 /etc/nodenesia-static-gost/gost.json

cat >/etc/systemd/system/nodenesia-static-gost.service <<EOF
[Unit]
Description=Nodenesia Static Residential GOST control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${STATIC_GOST_SERVICE_USER}
Group=${STATIC_GOST_SERVICE_USER}
ExecStart=/usr/local/bin/gost-static -C /etc/nodenesia-static-gost/gost.json -api ${STATIC_GOST_API_ADDR}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/nodenesia-static-gost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nodenesia-static-gost
echo "[static-gost] Ready. Web API is private at ${STATIC_GOST_API_ADDR}. Do not expose it through nginx."
