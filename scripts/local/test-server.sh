#!/usr/bin/env bash
# Run the built standalone server against a disposable COPY of the Study
# app's data, so manual tests never touch real sessions.
#
#   scripts/local/test-server.sh            # copy data once, serve on :3917
#   scripts/local/test-server.sh --fresh    # re-copy the data first
#
# Build first: npm run build && node scripts/build-server.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${LH_STUDY_PROFILE:-$HOME/.local/share/learnharness-electron45/profile}"
COPY="${LH_TEST_COPY:-${XDG_CACHE_HOME:-$HOME/.cache}/learnharness-test-copy}"
PORT="${PORT:-3917}"

[[ -f "$ROOT/.next/standalone/server.js" ]] || { echo "No build: run npm run build && node scripts/build-server.mjs" >&2; exit 1; }

if [[ "${1:-}" == "--fresh" ]]; then rm -rf "$COPY"; fi
if [[ ! -d "$COPY/data" ]]; then
  mkdir -p "$COPY"
  cp -r "$PROFILE/data" "$COPY/data"
  for f in auth.json chatgpt-credentials.json github-copilot-credentials.json; do
    [[ -f "$PROFILE/$f" ]] && cp "$PROFILE/$f" "$COPY/"
  done
  echo "Copied Study data to $COPY"
fi

echo "Serving http://127.0.0.1:$PORT (data: $COPY/data)"
cd "$ROOT/.next/standalone"
NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 \
  LH_DATA_DIR="$COPY/data" LH_AUTH_FILE="$COPY/auth.json" \
  exec node server.js
