#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export PATH=/opt/jbremote-node/bin:$PATH
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 LTS is required in /opt/jbremote-node")'
npm ci --omit=dev --no-fund
npm test
node install-release.cjs
if pm2 describe jbdesk-server >/dev/null 2>&1; then
  pm2 restart ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$(id -un)" --hp "$HOME"
curl --fail --silent http://127.0.0.1:3001/health
# Provision TLS first; apply nginx.conf after reviewing the existing virtual hosts.
# Do not reset the repository or overwrite other sites from this script.
