#!/bin/zsh
# Puts Gulpy on a server and gives it a public https address through a Cloudflare tunnel.
# Run it again to send new code. It keeps the data that the server has.
#
#   scripts/deploy-vm.sh                                  # exahuman-2, https://app.gulpy.ai
#   GULPY_VM=my-host GULPY_HOST=x.gulpy.ai scripts/deploy-vm.sh
#
# GULPY_OLD_HOSTS: other names that the tunnel serves; Gulpy sends them to GULPY_HOST (default cloud.gulpy.ai).
# GULPY_MASTER_KEY_NAME: the Keychain item of the master key (default gulpy-prod-master-key, the key of the
# app.gulpy.ai data). Keys for Stripe, Google and Microsoft go to the server if they are in the Keychain.
#
# You need: an SSH host with Docker and sudo, `cloudflared` with a login for the domain, and
# `gulpy-resend-api-key` in the macOS Keychain. The script makes the master key of the server,
# keeps it in the Keychain as `gulpy-vm-master-key`, and sends it to the server. It prints no secret.
set -euo pipefail
cd "${0:A:h}/.."

VM="${GULPY_VM:-exahuman-2}"
HOST="${GULPY_HOST:-app.gulpy.ai}"
OLD_HOSTS=(${=GULPY_OLD_HOSTS-cloud.gulpy.ai})
MASTER_KEY_NAME="${GULPY_MASTER_KEY_NAME:-gulpy-prod-master-key}"
TUNNEL="${GULPY_TUNNEL:-gulpy-vm}"
MAIL_FROM="${MAIL_FROM:-Gulpy <skyler@gulpy.ai>}"
DIR=/opt/gulpy

key() { security find-generic-password -s "$1" -w; }
# A secret that is not in the Keychain. The server starts without it.
optional() { security find-generic-password -s "$1" -w 2>/dev/null || true; }
remote() { ssh -o LogLevel=ERROR "$VM" "$@"; }

echo "[deploy] server: $VM, address: https://$HOST"

# 1. The master key. It encrypts the tokens, so a copy stays in the Keychain.
if ! security find-generic-password -s "$MASTER_KEY_NAME" >/dev/null 2>&1; then
  security add-generic-password -a "$USER" -s "$MASTER_KEY_NAME" -w "$(openssl rand -base64 32)" -U
  echo "[deploy] made $MASTER_KEY_NAME in the Keychain"
fi

# 2. The tunnel and its DNS name.
tunnel_id() { cloudflared tunnel list 2>/dev/null | awk -v name="$TUNNEL" '$2 == name {print $1}'; }
if [[ -z "$(tunnel_id)" ]]; then
  cloudflared tunnel create "$TUNNEL" >/dev/null 2>&1
  echo "[deploy] made the tunnel $TUNNEL"
fi
TUNNEL_ID="$(tunnel_id)"
[[ -n "$TUNNEL_ID" ]] || { echo "[deploy] no tunnel with the name $TUNNEL" >&2; exit 1; }
[[ -f "$HOME/.cloudflared/$TUNNEL_ID.json" ]] || { echo "[deploy] the credentials of the tunnel are not on this computer" >&2; exit 1; }
# The config file of this computer can name a different tunnel, and then cloudflared gives the name to
# that tunnel. An empty config file and the id of the tunnel prevent this.
EMPTY="$(mktemp)"
for name in "$HOST" "${OLD_HOSTS[@]}"; do
  cloudflared --config "$EMPTY" tunnel route dns --overwrite-dns "$TUNNEL_ID" "$name" >/dev/null 2>&1 || true
done
rm -f "$EMPTY"

# 3. The secrets, through SSH. Only root on the server can read them.
remote "sudo install -d -m 700 /etc/gulpy && sudo install -d -m 755 /etc/gulpy/cloudflared && sudo install -d -o \$(id -u) -g \$(id -g) $DIR"
{
  printf 'NODE_ENV=production\n'
  printf 'GULPY_BASE_URL=https://%s\n' "$HOST"
  printf 'MAIL_FROM=%s\n' "$MAIL_FROM"
  printf 'GULPY_MASTER_KEY=%s\n' "$(key "$MASTER_KEY_NAME")"
  printf 'RESEND_API_KEY=%s\n' "$(key gulpy-resend-api-key)"
  printf 'GULPY_REDIRECT_HOSTS=%s\n' "${(j:,:)OLD_HOSTS}"
  for pair in STRIPE_SECRET_KEY:gulpy-stripe-secret-key STRIPE_WEBHOOK_SECRET:gulpy-stripe-webhook-secret \
    GOOGLE_CLIENT_ID:gulpy-google-client-id GOOGLE_CLIENT_SECRET:gulpy-google-client-secret \
    MICROSOFT_CLIENT_ID:gulpy-microsoft-client-id MICROSOFT_CLIENT_SECRET:gulpy-microsoft-client-secret; do
    value="$(optional "${pair#*:}")"
    if [[ -n "$value" ]]; then printf '%s=%s\n' "${pair%%:*}" "$value"; fi
  done
} | remote "sudo sh -c 'umask 077; cat > /etc/gulpy/env'"
# The tunnel program in the container is user 65532.
remote "sudo sh -c 'umask 077; cat > /etc/gulpy/cloudflared/creds.json; chown 65532:65532 /etc/gulpy/cloudflared/creds.json; chmod 400 /etc/gulpy/cloudflared/creds.json'" \
  < "$HOME/.cloudflared/$TUNNEL_ID.json"
{
  printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/creds.json\ningress:\n' "$TUNNEL_ID"
  for name in "$HOST" "${OLD_HOSTS[@]}"; do printf '  - hostname: %s\n    service: http://gulpy:8080\n' "$name"; done
  printf '  - service: http_status:404\n'
} | remote "sudo sh -c 'cat > /etc/gulpy/cloudflared/config.yml'"

# 4. The code. The data of this computer and the tests do not go to the server.
rsync -az --delete -e "ssh -o LogLevel=ERROR" \
  --exclude .git --exclude node_modules --exclude .data --exclude ".env*" --exclude test --exclude examples \
  --exclude docs --exclude "*.log" --exclude .DS_Store \
  ./ "$VM:$DIR/"

# 5. Build and start.
remote "cd $DIR && sudo docker compose -f deploy/compose.yml up -d --build --remove-orphans 2>&1 | tail -5"

# 6. Check from the server, through the public address.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if remote "curl -fsS -m 10 https://$HOST/health" 2>/dev/null; then
    echo
    echo "[deploy] https://$HOST is up"
    exit 0
  fi
  sleep 6
done
echo "[deploy] https://$HOST did not answer. See: ssh $VM 'cd $DIR && sudo docker compose -f deploy/compose.yml logs --tail 50'" >&2
exit 1
