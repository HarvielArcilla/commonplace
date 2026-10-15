#!/usr/bin/env bash
# Starts commonplace (macOS and Linux). Used by the Desktop / menu launcher.
set -euo pipefail
cd "$(dirname "$0")/.."
# Started from Finder or a menu, PATH is minimal: look where Node usually is.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi
fi
exec npm run dev
