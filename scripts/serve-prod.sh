#!/bin/zsh
# Runs Gulpy in production mode on this Mac, for https://app.gulpy.ai through a Cloudflare tunnel.
# launchd starts it at login and restarts it: ~/Library/LaunchAgents/ai.gulpy.server.plist
# Port 4700: 8787 belongs to the opfinder radar service on this Mac.
# The secrets come from the macOS Keychain at start. They are not written to a file.
set -euo pipefail
cd "${0:A:h}/.."

key() { security find-generic-password -s "$1" -w; }
# A secret that is not in the Keychain yet. The server starts without it.
optional() { security find-generic-password -s "$1" -w 2>/dev/null || true; }

export NODE_ENV=production
export PORT=4700
export GULPY_BASE_URL=https://app.gulpy.ai
export GULPY_DB="$HOME/Library/Application Support/Gulpy/gulpy.db"
export GULPY_MASTER_KEY="$(key gulpy-prod-master-key)"
export RESEND_API_KEY="$(key gulpy-resend-api-key)"
export MAIL_FROM="Gulpy <skyler@gulpy.ai>"
# Paid plans. Test keys until the Stripe account is live; then put the live keys in the same items.
export STRIPE_SECRET_KEY="$(optional gulpy-stripe-secret-key)"
export STRIPE_WEBHOOK_SECRET="$(optional gulpy-stripe-webhook-secret)"

exec "$HOME/.bun/bin/bun" run src/main.ts
