#!/bin/bash
set -e

VPS_IP="${1:-<VPS_IP_ANDA>}"
VPS_USER="${2:-ubuntu}"
VPS_DIR="/home/${VPS_USER}/nawasena-x-openwa"

echo "🔨 [1/3] Building TypeScript Locally (NestJS)..."
npm run build

echo "📤 [2/3] Uploading Dist & Project Files to VPS (${VPS_USER}@${VPS_IP})..."
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'data/*.db*' \
  --exclude 'data/sessions' \
  --exclude 'data/media' \
  ./ ${VPS_USER}@${VPS_IP}:${VPS_DIR}/

echo "⚡ [3/3] Executing Remote Deployment Script on VPS..."
ssh ${VPS_USER}@${VPS_IP} "cd ${VPS_DIR} && ./deploy-vps.sh"

echo "🎉 Deployment to VPS finished successfully!"
