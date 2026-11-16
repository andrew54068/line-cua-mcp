#!/usr/bin/env bash
# Build "LINE Reader.app" (see helper/line-reader.c).
#   scripts/build-helper.sh [OUT.app]          production build
#   LINE_READER_TEST=1 scripts/build-helper.sh  test build: fake home + fake key, other bundle ID
# Ad-hoc signed with the hardened runtime. The build is deterministic, so the
# CDHash (and any permission granted to it) only changes when the source does.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/dist/LINE Reader.app"}
ID=com.dawson.line-reader
CFLAGS=()
if [[ "${LINE_READER_TEST:-}" == 1 ]]; then
  ID=com.dawson.line-reader.test
  CFLAGS=(-DLINE_READER_TEST)
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
cp "$ROOT/helper/Info.plist" "$OUT/Contents/Info.plist"
if [[ "${LINE_READER_TEST:-}" == 1 ]]; then
  plutil -replace CFBundleIdentifier -string "$ID" "$OUT/Contents/Info.plist"
  plutil -replace CFBundleName -string "LINE Reader Test" "$OUT/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "LINE Reader Test" "$OUT/Contents/Info.plist"
fi
xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 ${CFLAGS[@]+"${CFLAGS[@]}"} \
  -o "$OUT/Contents/MacOS/line-reader" "$ROOT/helper/line-reader.c"
codesign --force --sign - --options runtime --identifier "$ID" "$OUT" 2>/dev/null
codesign --verify --strict "$OUT"
codesign -dvvv "$OUT" 2>&1 | sed -n 's/^CDHash=//p'
