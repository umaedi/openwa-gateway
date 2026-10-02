#!/usr/bin/env bash
# Deploy a production-ready OpenWA build without sending source or persistent server data.
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Override these when invoking the script, for example:
# VPS_HOST=172.16.4.36 VPS_USER=k0minf0 SSH_PORT=6969 ./deploy.sh
# Note: openwa-gateway PM2 is now running as root (see pm2 status as root),
# so remote pm2 commands run via sudo.
VPS_HOST="${VPS_HOST:-172.16.4.36}"
VPS_USER="${VPS_USER:-k0minf0}"
VPS_PATH="${VPS_PATH:-/home/k0minf0/services/openwa-gateway}"
SSH_PORT="${SSH_PORT:-6969}"
APP_NAME="${APP_NAME:-openwa-gateway}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is required." >&2
  exit 1
fi

if [[ -n "${VPS_PASSWORD:-}" ]] && ! command -v sshpass >/dev/null 2>&1; then
  echo "Error: VPS_PASSWORD was supplied, but sshpass is not installed." >&2
  exit 1
fi

SSH_COMMAND=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
if [[ -n "${VPS_PASSWORD:-}" ]]; then
  export SSHPASS="$VPS_PASSWORD"
  SSH_COMMAND=(sshpass -e "${SSH_COMMAND[@]}")
  RSYNC_RSH="sshpass -e ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new"
else
  printf -v RSYNC_RSH '%q ' "${SSH_COMMAND[@]}"
fi

REMOTE="$VPS_USER@$VPS_HOST"

cd "$PROJECT_ROOT"

echo "==> Building production artifact locally"
npm run build
test -f dist/main.js || { echo "Error: local build did not produce dist/main.js." >&2; exit 1; }

echo "==> Ensuring remote application directory exists"
"${SSH_COMMAND[@]}" "$REMOTE" "mkdir -p '$VPS_PATH'"

echo "==> Uploading runtime artifacts"
# --delete applies only inside dist/ and removes stale compiled files. It cannot touch
# .env, data/, logs/, or any other server-managed directory.
rsync -az --delete -e "$RSYNC_RSH" dist/ "$REMOTE:$VPS_PATH/dist/"
# npm's postinstall hook and its dependency patchers are the only source scripts required at
# runtime; specs, export tools, and other development scripts stay local.
rsync -az --delete -e "$RSYNC_RSH" \
  --include='postinstall.js' \
  --include='patch-*.js' \
  --exclude='*' \
  scripts/ "$REMOTE:$VPS_PATH/scripts/"
rsync -az -e "$RSYNC_RSH" package.json package-lock.json ecosystem.config.cjs "$REMOTE:$VPS_PATH/"
if [[ -f ".env" ]]; then
  rsync -az -e "$RSYNC_RSH" .env "$REMOTE:$VPS_PATH/.env"
fi

echo "==> Installing production dependencies and reloading PM2"
printf -v VPS_PASSWORD_Q '%q' "${VPS_PASSWORD:-}"
"${SSH_COMMAND[@]}" "$REMOTE" "VPS_PASSWORD=$VPS_PASSWORD_Q bash -se" <<REMOTE_COMMAND
set -Eeuo pipefail
cd '$VPS_PATH'

# npm ci uses package-lock.json exactly and runs the production dependency patchers
# from scripts/.  No TypeScript compilation happens on the server.
npm ci --omit=dev
mkdir -p logs data

# PM2 now runs as root (unified pm2 status); use sudo for pm2 commands.
# VPS_PASSWORD is passed as env for sudo -S when password auth is used.
pm2_root() {
  if [[ -n "\${VPS_PASSWORD:-}" ]]; then
    printf '%s\n' "\$VPS_PASSWORD" | sudo -S pm2 "\$@"
  else
    sudo -n pm2 "\$@"
  fi
}

if pm2_root describe '$APP_NAME' >/dev/null 2>&1; then
  pm2_root reload ecosystem.config.cjs --only '$APP_NAME' --update-env
else
  pm2_root start ecosystem.config.cjs --only '$APP_NAME'
fi

pm2_root save
pm2_root status '$APP_NAME'
REMOTE_COMMAND

echo "==> Deployment complete: $APP_NAME is running on $REMOTE"
