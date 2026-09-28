#!/bin/zsh
# Runs Gulpy in production mode on this Mac, for https://gulpy.ai through a Cloudflare tunnel.
# The secrets come from the macOS Keychain at start. They are not written to a file.
set -euo pipefail
cd "${0:A:h}/.."

key() { security find-generic-password -s "$1" -w; }

export NODE_ENV=production
export PORT=8787
export GULPY_BASE_URL=https://gulpy.ai
export GULPY_DB="$HOME/Library/Application Support/Gulpy/gulpy.db"
export GULPY_MASTER_KEY="$(key gulpy-prod-master-key)"
export RESEND_API_KEY="$(key gulpy-resend-api-key)"
export MAIL_FROM="Gulpy <skyler@gulpy.ai>"

exec "$HOME/.bun/bin/bun" run src/main.ts
