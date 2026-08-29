#!/usr/bin/env bash
set -e

# Konfigurasi VPS
VPS_HOST="43.159.58.101"
VPS_USER="ubuntu"
VPS_PATH="/var/www/nawasena-x-openwa"
SSH_PORT="22"

# Remote SSH command (gunakan sshpass jika VPS_PASSWORD diisi)
if [ -n "$VPS_PASSWORD" ]; then
  SSH_CMD="sshpass -p $VPS_PASSWORD ssh -p $SSH_PORT -o StrictHostKeyChecking=no"
else
  SSH_CMD="ssh -p $SSH_PORT"
fi

echo "📦 Building project..."
npm run build

echo "📤 Mengunggah berkas yang diperlukan ke VPS ($VPS_HOST:$VPS_PATH)..."
rsync -avz -e "$SSH_CMD" \
  dist \
  scripts \
  package.json \
  package-lock.json \
  ecosystem.config.cjs \
  "$VPS_USER@$VPS_HOST:$VPS_PATH/"

if [ -f ".env" ]; then
  rsync -avz -e "$SSH_CMD" .env "$VPS_USER@$VPS_HOST:$VPS_PATH/.env"
fi

echo "✅ Berhasil upload ke VPS!"
