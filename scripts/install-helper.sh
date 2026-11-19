#!/usr/bin/env bash
# Install "LINE Reader.app" into ~/Applications on the Mac that runs LINE.
# Replaces the installed copy only when the build differs, so macOS
# permission grants (bound to the CDHash) survive unchanged reinstalls.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HOME/Applications/LINE Reader.app"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

new=$(bash "$ROOT/scripts/build-helper.sh" "$STAGE/LINE Reader.app")
old=$(codesign -dvvv "$DEST" 2>&1 | sed -n 's/^CDHash=//p' || true)
if [[ "$new" == "$old" ]]; then
  echo "LINE Reader.app unchanged (CDHash $new); existing permission grants stay valid."
  exit 0
fi
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
ditto "$STAGE/LINE Reader.app" "$DEST"
echo "Installed $DEST (CDHash $new)."
if [[ -n "$old" ]]; then
  echo "The build changed: macOS will ask again, and a Full Disk Access entry for LINE Reader must be re-added."
fi
