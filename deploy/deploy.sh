#!/usr/bin/env bash
# deploy.sh: Local Build & Test Gate + EC2 Deployment for scalpX
set -euo pipefail

EC2_HOST="${EC2_HOST:-}"
REMOTE_DIR="/opt/scalpx"
SERVICE_NAME="flattrade-engine"
ENV_FILE="/etc/scalpx/env"
DATA_DIR="/var/lib/scalpx"
BACKUP_DIR="${DATA_DIR}/deploy-backups"

if [[ -z "${EC2_HOST}" || "${EC2_HOST}" == *YOUR_EC2* ]]; then
  echo "Set EC2_HOST to the deployment host before running this script." >&2
  exit 2
fi

echo "========================================================"
echo "⚡ scalpX Deployment Pipeline"
echo "========================================================"

# Step 1: Local Test & Typecheck Gate (Fail-Fast)
echo "🔍 Running Typecheck and Full Test Suite..."
npm run typecheck
npm test

echo "✅ All tests and type checks passed (100% gate pass)."

# Step 2: Build Production JS Bundle
echo "🏗️ Building production bundle (tsc)..."
npm run build

echo "🔎 Checking remote deployment paths and service configuration..."
ssh "${EC2_HOST}" << EOF
  set -euo pipefail
  test -d '${REMOTE_DIR}'
  test -w '${REMOTE_DIR}'
  test -r '${ENV_FILE}'
  test -d '${DATA_DIR}'
  test -w '${DATA_DIR}'
  sudo install -d -m 0750 -o "\$(stat -c '%U' '${REMOTE_DIR}')" -g "\$(stat -c '%G' '${REMOTE_DIR}')" '${BACKUP_DIR}'
  test "\$(sudo systemctl show '${SERVICE_NAME}' -p WorkingDirectory --value)" = '${REMOTE_DIR}'
EOF

# Capture the current deployable tree outside REMOTE_DIR before rsync --delete.
BACKUP_NAME="scalpx-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
ssh "${EC2_HOST}" "sudo tar -czf '${BACKUP_DIR}/${BACKUP_NAME}' --exclude='./node_modules' --exclude='./.git' --exclude='./.env' --exclude='./.env.*' --exclude='./data' --exclude='*.db' --exclude='*.db-*' --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='*.log' -C '${REMOTE_DIR}' . && sudo chown \$(stat -c '%U:%G' '${REMOTE_DIR}') '${BACKUP_DIR}/${BACKUP_NAME}'"

# Step 3: Rsync to AWS EC2 t4g.micro
echo "🚀 Syncing files to AWS EC2 instance (${EC2_HOST})..."
rsync -avz --delete-delay \
  --exclude '/node_modules/' \
  --exclude '/.git/' \
  --exclude '/.env' \
  --exclude '/.env.*' \
  --exclude '*.db' \
  --exclude '*.db-*' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-*' \
  --exclude '*.log' \
  --exclude '/data/' \
  ./ "${EC2_HOST}:${REMOTE_DIR}/"

# Step 4: Remote npm ci and service restart
echo "🔄 Running remote installation and restarting systemd service..."
ssh "${EC2_HOST}" "BACKUP_PATH='${BACKUP_DIR}/${BACKUP_NAME}' bash -s" << 'EOF'
  set -euo pipefail
  rollback() {
    echo "Deployment failed; restoring ${BACKUP_PATH}." >&2
    restore_dir="$(mktemp -d)"
    sudo tar -xzf "${BACKUP_PATH}" -C "${restore_dir}"
    sudo rsync -a --delete \
      --exclude='node_modules/' --exclude='.env' --exclude='.env.*' \
      --exclude='*.db' --exclude='*.db-*' --exclude='*.sqlite' --exclude='*.sqlite-*' \
      --exclude='*.log' --exclude='data/' "${restore_dir}/" /opt/scalpx/
    rm -rf "${restore_dir}"
    cd /opt/scalpx
    npm ci --omit=dev || true
    sudo systemctl restart flattrade-engine || true
  }
  trap 'rollback' ERR
  cd /opt/scalpx
  npm ci --omit=dev
  sudo systemctl restart flattrade-engine
  for attempt in {1..30}; do
    if curl --fail --silent --show-error http://127.0.0.1:3000/health/live >/dev/null; then
      sudo systemctl is-active --quiet flattrade-engine
      echo "Health check passed."
      exit 0
    fi
    sleep 2
  done
  sudo systemctl status flattrade-engine --no-pager
  echo "Health check failed after 60 seconds." >&2
  false
EOF

echo "========================================================"
echo "🎉 Deployment successfully completed!"
echo "========================================================"
