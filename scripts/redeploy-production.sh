#!/usr/bin/env bash

# Rebuild and restart an already-provisioned Nodenesia deployment.
# Run as the deployment user, for example:
#   APP_DIR=/home/ubuntu/nova-store bash scripts/redeploy-production.sh

set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-nodenesia-api}"
NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
INSTALL_DEPENDENCIES="${INSTALL_DEPENDENCIES:-false}"

die() { printf '[nodenesia-redeploy] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[nodenesia-redeploy] %s\n' "$*"; }

[[ -f "$APP_DIR/package.json" ]] || die "package.json was not found in APP_DIR=$APP_DIR"
[[ -s "$NVM_DIR/nvm.sh" ]] || die "NVM was not found at $NVM_DIR; set NVM_DIR to the deployment user's NVM directory"
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || die 'Node.js/npm are unavailable through NVM'

cd "$APP_DIR"
if [[ "$INSTALL_DEPENDENCIES" == 'true' ]]; then
  log 'Installing updated dependencies from package-lock.json'
  npm ci
fi

log 'Building frontend and API'
npm run build

log "Restarting ${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}.service"
sudo systemctl is-active --quiet "${SERVICE_NAME}.service" || {
  sudo journalctl -u "${SERVICE_NAME}.service" --no-pager -n 100 || true
  die 'API service did not restart'
}

log 'Redeploy complete'
