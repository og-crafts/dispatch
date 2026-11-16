#!/usr/bin/env bash
# One-time set-up of in-app updates (run by the owner; see docs/RELEASING.md, "Auto-updates").
#
#   scripts/setup-updater.sh [path of the private key, default ~/keys/dispatch-updater.key]
#
# 1. Makes the update key pair. The private key and a random password stay on this machine (in ~/keys, which
#    ~/bin/backup-secrets includes). Losing them means installed copies can never update again, so back them up.
# 2. Puts the public key and the update address into src-tauri/tauri.conf.json (commit that in a PR).
# 3. Stores the private key and its password as GitHub secrets of og-crafts/dispatch, so release tags are signed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"

KEY="${1:-$HOME/keys/dispatch-updater.key}"
PASS_FILE="$KEY.password"
REPO="og-crafts/dispatch"

if [ -e "$KEY" ]; then
  echo "$KEY already exists. A new key would stop every installed copy from updating; not replacing it." >&2
  echo "To only redo steps 2-3 with the existing key, run: SKIP_GENERATE=1 $0 $KEY" >&2
  [ "${SKIP_GENERATE:-}" = 1 ] || exit 1
fi

if [ "${SKIP_GENERATE:-}" != 1 ]; then
  mkdir -p "$(dirname "$KEY")"
  umask 077
  openssl rand -base64 32 | tr -d '\n' > "$PASS_FILE"
  ./node_modules/.bin/tauri signer generate --ci -w "$KEY" -p "$(cat "$PASS_FILE")" > /dev/null
  echo "Made $KEY (+ .pub) and $PASS_FILE."
fi

PUB="$(cat "$KEY.pub")"
node - "$PUB" <<'EOF'
const fs = require('node:fs')
const p = 'src-tauri/tauri.conf.json'
const c = JSON.parse(fs.readFileSync(p, 'utf8'))
c.plugins = { ...(c.plugins ?? {}), updater: {
  pubkey: process.argv[2],
  endpoints: ['https://github.com/og-crafts/dispatch/releases/latest/download/latest.json'],
  windows: { installMode: 'passive' },
} }
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n')
console.log(`Wrote the public key into ${p}.`)
EOF

GH_TOKEN="$(gh auth token --user og-crafts)" gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" < "$KEY"
GH_TOKEN="$(gh auth token --user og-crafts)" gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO" < "$PASS_FILE"
echo "Set the GitHub secrets on $REPO."
echo
echo "Next: commit src-tauri/tauri.conf.json (a PR), then run ~/bin/backup-secrets and keep the archive off this machine."
