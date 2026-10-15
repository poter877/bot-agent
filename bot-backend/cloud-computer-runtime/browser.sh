#!/usr/bin/env bash
set -euo pipefail
# Docker owns the OS isolation; its no-new-privileges policy forbids Chromium's setuid helper.
exec chromium --no-sandbox --disable-dev-shm-usage --no-first-run \
  --user-data-dir="$HOME/browser-profile" "$@"
