#!/usr/bin/env bash
# deploy.sh: Local Build & Test Gate + EC2 Deployment for scalpX
set -euo pipefail

EC2_HOST="${EC2_HOST:-ubuntu@YOUR_EC2_ELASTIC_IP}"
REMOTE_DIR="/home/ubuntu/flattrade-engine"

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

# Step 3: Rsync to AWS EC2 t4g.micro
echo "🚀 Syncing files to AWS EC2 instance (${EC2_HOST})..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '*.db' \
  --exclude '*.log' \
  ./ "${EC2_HOST}:${REMOTE_DIR}/"

# Step 4: Remote npm ci and service restart
echo "🔄 Running remote installation and restarting systemd service..."
ssh "${EC2_HOST}" << 'EOF'
  set -euo pipefail
  cd /home/ubuntu/flattrade-engine
  npm ci --omit=dev
  sudo systemctl restart flattrade-engine
  sleep 2
  sudo systemctl status flattrade-engine --no-pager
  curl -s http://127.0.0.1:3000/health | jq .
EOF

echo "========================================================"
echo "🎉 Deployment successfully completed!"
echo "========================================================"
