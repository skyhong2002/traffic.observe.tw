#!/usr/bin/env bash
set -euo pipefail

# Publish only committed files, even when other work is present in the checkout.
# Usage: bash tools/deploy-web.sh <commit> [--activate]
project_dir=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
revision=$(git -C "$project_dir" rev-parse --verify "${1:?Pass a commit}^{commit}")
action=${2:---prepare}
if [[ "$action" != --prepare && "$action" != --activate ]]; then
  echo 'Expected --prepare or --activate' >&2
  exit 2
fi
if ! git -C "$project_dir" show "$revision:package-lock.json" | cmp -s - "$project_dir/package-lock.json"; then
  echo 'Release dependencies differ from the installed checkout; install matching dependencies first.' >&2
  exit 1
fi
test -d "$project_dir/node_modules"
release_dir="$project_dir/data/web-releases/$revision"
mkdir -p "$project_dir/data/web-releases"
if [[ ! -f "$release_dir/.release-revision" ]]; then
  staging_dir=$(mktemp -d "$project_dir/data/web-releases/.prepare.XXXXXX")
  trap 'rm -rf "$staging_dir"' EXIT
  git -C "$project_dir" archive "$revision" | tar -x -C "$staging_dir"
  ln -s "$project_dir/node_modules" "$staging_dir/node_modules"
  ln -s "$project_dir/data" "$staging_dir/data"
  printf '%s\n' "$revision" > "$staging_dir/.release-revision"
  mv "$staging_dir" "$release_dir"
  trap - EXIT
fi
printf 'Prepared %s\n' "$release_dir"
[[ "$action" == --activate ]] || exit 0

service=traffic-observe-web.service
current_link="$project_dir/data/web-release-current"
override_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$service.d"
override_file="$override_dir/20-committed-release.conf"
record_dir=$(mktemp -d "$project_dir/data/web-releases/activation.XXXXXX")
previous_target=$(readlink "$current_link" || true)
if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  echo "$current_link must be a symlink" >&2
  exit 1
fi
mkdir -p "$override_dir"
if [[ -f "$override_file" ]]; then
  cp "$override_file" "$record_dir/previous-override.conf"
fi
systemctl --user show "$service" -p MainPID -p WorkingDirectory > "$record_dir/before.txt"
systemctl --user show traffic-observe-worker.service -p MainPID > "$record_dir/worker-before.txt"
printf '%s\n' "$previous_target" > "$record_dir/previous-target.txt"
printf '%s\n' "$revision" > "$record_dir/revision.txt"

restore_previous() {
  if [[ -n "$previous_target" ]]; then
    ln -s "$previous_target" "$current_link.rollback"
    mv -Tf "$current_link.rollback" "$current_link"
  else
    rm -f "$current_link"
  fi
  if [[ -f "$record_dir/previous-override.conf" ]]; then
    cp "$record_dir/previous-override.conf" "$override_file"
  else
    rm -f "$override_file"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$service"
}
ln -s "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
printf '[Service]\nWorkingDirectory=%s\n' "$current_link" > "$override_file"
if ! { systemctl --user daemon-reload && systemctl --user restart "$service"; }; then
  restore_previous
  exit 1
fi
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:18150/healthz > "$record_dir/health.json"; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo 'Web health check failed; restoring previous release.' >&2
  restore_previous
  exit 1
fi
systemctl --user show "$service" -p MainPID -p WorkingDirectory > "$record_dir/after.txt"
systemctl --user show traffic-observe-worker.service -p MainPID > "$record_dir/worker-after.txt"
cmp "$record_dir/worker-before.txt" "$record_dir/worker-after.txt"
printf 'Activated %s; record %s\n' "$revision" "$record_dir"
