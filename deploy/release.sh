#!/usr/bin/env bash
# Sends a built image to the server and starts it. If the new copy does not answer, it starts the
# previous image again. GitHub Actions runs this (.github/workflows/deploy.yml).
#
#   deploy/release.sh test|production <image>
#
# Needs: VM, VM_ZONE, GCP_PROJECT, DEPLOY_USER, gcloud with a login, ~/.ssh/deploy and ~/.ssh/known_hosts.
# The secrets of the app are already on the server in /etc/<project>. This script sends none.
set -euo pipefail

target="$1" image="$2"
case "$target" in
  test)       project=gulpy-test host=test.gulpy.ai ;;
  production) project=gulpy      host=app.gulpy.ai ;;
  *) echo "usage: $0 test|production <image>" >&2; exit 2 ;;
esac

vm() {
  ssh -i ~/.ssh/deploy -o IdentitiesOnly=yes -o HostKeyAlias="$VM" -o StrictHostKeyChecking=yes \
    -o ProxyCommand="gcloud compute start-iap-tunnel $VM 22 --listen-on-stdin --zone $VM_ZONE --project $GCP_PROJECT --verbosity=warning" \
    "$DEPLOY_USER@$VM" "$@"
}
compose="sudo env GULPY_ETC=/etc/$project GULPY_IMAGE=$project:latest docker compose -p $project -f /opt/$project/deploy/compose.yml"

echo "[release] $image -> https://$host ($project on $VM)"

# 1. The image. Built and tested by CI, so the server does not build.
docker save "$image" | gzip -1 | vm "gunzip | sudo docker load"

# 2. The compose file, and the image names: latest is the new one, previous the one before.
vm "sudo install -d /opt/$project/deploy && sudo tee /opt/$project/deploy/compose.yml >/dev/null" < deploy/compose.yml
vm "sudo docker image inspect $project:latest >/dev/null 2>&1 && sudo docker tag $project:latest $project:previous || true
    sudo docker tag $image $project:latest"

# 3. Start the app. The tunnel keeps running.
start() { vm "$compose up -d --no-build --wait --wait-timeout 120 gulpy"; }
healthy() {
  for _ in $(seq 1 10); do
    vm "curl -fsS -m 10 https://$host/health" && return 0
    sleep 6
  done
  return 1
}

if start && healthy; then
  echo
  echo "[release] https://$host is up with $image"
  vm "sudo docker image prune -f >/dev/null"
  exit 0
fi

echo "::error::https://$host did not answer with $image. Starting the previous image again."
vm "$compose logs --tail 50 gulpy" || true
vm "sudo docker tag $project:previous $project:latest" && start && healthy || echo "::error::The previous image did not answer either."
exit 1
