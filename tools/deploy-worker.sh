#!/usr/bin/env bash
set -euo pipefail
# Usage: bash tools/deploy-worker.sh <commit> [--activate]
project_dir=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
revision=$(git -C "$project_dir" rev-parse --verify "${1:?Pass a commit}^{commit}")
action=${2:---prepare}
[[ "$action" == --prepare || "$action" == --activate ]] || { echo 'Expected --prepare or --activate' >&2; exit 2; }
bash "$project_dir/tools/deploy-web.sh" "$revision" --prepare
[[ "$action" == --activate ]] || exit 0
service=traffic-observe-worker.service
release_dir="$project_dir/data/web-releases/$revision"
current_link="$project_dir/data/worker-release-current"
override_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$service.d"
override_file="$override_dir/20-committed-release.conf"
[[ ! -e "$current_link" || -L "$current_link" ]] || { echo 'Worker release target must be a symlink' >&2; exit 1; }
record_dir=$(mktemp -d "$project_dir/data/web-releases/worker-activation.XXXXXX")
previous_target=$(readlink "$current_link" || true)
mkdir -p "$override_dir"
[[ ! -f "$override_file" ]] || cp "$override_file" "$record_dir/previous-override.conf"
printf '%s\n' "$revision" > "$record_dir/revision.txt"
printf '%s\n' "$previous_target" > "$record_dir/previous-target.txt"
restore_previous() {
  if [[ -n "$previous_target" ]]; then
    ln -s "$previous_target" "$current_link.rollback"
    mv -Tf "$current_link.rollback" "$current_link"
  else rm -f "$current_link"; fi
  if [[ -f "$record_dir/previous-override.conf" ]]; then cp "$record_dir/previous-override.conf" "$override_file"; else rm -f "$override_file"; fi
  systemctl --user daemon-reload
  systemctl --user restart "$service"
}
ln -s "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
printf '[Service]\nWorkingDirectory=%s\n' "$current_link" > "$override_file"
if ! { systemctl --user daemon-reload && systemctl --user restart "$service"; }; then restore_previous; exit 1; fi
# Detect startup failure and verify the process really runs the selected archive.
sleep 3
pid=$(systemctl --user show "$service" -p MainPID --value)
if ! systemctl --user is-active --quiet "$service" || [[ "$pid" == 0 ]] || [[ "$(readlink -f "/proc/$pid/cwd")" != "$release_dir" ]]; then
  echo 'Worker startup/revision verification failed; restoring previous release.' >&2
  restore_previous
  exit 1
fi
systemctl --user show "$service" -p MainPID -p WorkingDirectory > "$record_dir/after.txt"
printf 'Activated worker %s; record %s\n' "$revision" "$record_dir"
