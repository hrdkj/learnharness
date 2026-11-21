#!/usr/bin/env bash
# Install this worktree's build into the local LearnHarness Study app
# (Electron 45 unpacked build). Keeps the previous server as a dated backup.
#
#   scripts/local/install-study.sh            # build, then install
#   scripts/local/install-study.sh --no-build # install the existing build
#
# Quit the app first: the bundled server is replaced in place.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${LH_STUDY_APP:-$HOME/Applications/LearnHarness-0.6.1-electron45}"
SERVER="$APP/resources/server"

if pgrep -f "^$APP/learnharness " >/dev/null; then
  echo "LearnHarness Study is running. Quit it, then rerun." >&2; exit 1
fi

cd "$ROOT"
if [[ "${1:-}" != "--no-build" ]]; then
  (cd plugins/coding-questions && npm run -s build)
  # Next may stop once on a security-advisory notice; a retry continues.
  npm run build || npm run build
  node scripts/build-server.mjs
  git checkout -q -- next-env.d.ts 2>/dev/null || true
fi
[[ -f .next/standalone/server.js ]] || { echo "No standalone build." >&2; exit 1; }

# The plugin dist may be newer than the Next build's copy.
rm -rf .next/standalone/core-plugins/coding-questions
cp -r plugins/coding-questions/dist .next/standalone/core-plugins/coding-questions

backup="$SERVER/backup-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
mv "$SERVER/standalone" "$backup"
cp -a .next/standalone "$SERVER/standalone"
echo "Installed $(git rev-parse --short HEAD) ($(git branch --show-current))."
echo "Previous server: $backup"
echo "Roll back: quit the app, then  rm -rf '$SERVER/standalone' && mv '$backup' '$SERVER/standalone'"
