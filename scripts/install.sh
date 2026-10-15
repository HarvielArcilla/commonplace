#!/usr/bin/env bash
# Installs Commonplace on macOS or Linux, from nothing.
#
#   curl -fsSL https://raw.githubusercontent.com/HarvielArcilla/commonplace/main/scripts/install.sh | bash
#
# What it does:
#   1. Checks for git (on a Mac, offers Apple's Command Line Tools if missing)
#   2. Checks for Node.js 20 or newer; installs Node 22 with nvm if needed
#      (in your home folder, no admin rights)
#   3. Downloads Commonplace to ~/Commonplace, or updates it if it's there
#   4. Installs its dependencies
#   5. Adds a Commonplace launcher (Desktop on macOS, app menu on Linux)
#
# Settings (environment variables):
#   COMMONPLACE_DIR=~/somewhere      install somewhere else
#   COMMONPLACE_NO_SHORTCUT=1        don't add a launcher
#   COMMONPLACE_REPO=<git url>       install from a fork

set -euo pipefail

REPO="${COMMONPLACE_REPO:-https://github.com/HarvielArcilla/commonplace.git}"
DIR="${COMMONPLACE_DIR:-$HOME/Commonplace}"
NVM_VERSION="v0.40.3"
NODE_MAJOR_MIN=20

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"

# --- 1. git -----------------------------------------------------------------
if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    say "Git is needed. macOS will now offer to install Apple's Command Line Tools."
    xcode-select --install 2>/dev/null || true
    fail "Finish that installation, then run this installer again."
  else
    fail "Git is needed. Install it with your package manager (for example: sudo apt install git), then run this again."
  fi
fi

# --- 2. Node.js ---------------------------------------------------------------
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MAJOR_MIN" ]
}

load_nvm
if ! node_ok; then
  say "Installing Node.js 22 with nvm (into your home folder)..."
  if ! command -v nvm >/dev/null 2>&1; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    load_nvm
  fi
  nvm install 22
  nvm use 22 >/dev/null
fi
node_ok || fail "Node.js ${NODE_MAJOR_MIN}+ is still missing. Install it from https://nodejs.org and run this again."
say "Using Node $(node -v) and $(git --version)"

# --- 3. Download or update ------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating Commonplace in $DIR..."
  git -C "$DIR" pull --ff-only
else
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fail "$DIR already exists and isn't a Commonplace folder. Set COMMONPLACE_DIR to install somewhere else."
  fi
  say "Downloading Commonplace to $DIR..."
  git clone --depth 1 "$REPO" "$DIR"
fi

# --- 4. Dependencies --------------------------------------------------------------
say "Installing dependencies (the first time downloads Electron, about 100 MB)..."
( cd "$DIR" && npm install --no-audit --no-fund )
chmod +x "$DIR/scripts/start.sh"

# --- 5. Launcher ---------------------------------------------------------------------
if [ "${COMMONPLACE_NO_SHORTCUT:-}" != "1" ]; then
  if [ "$OS" = "Darwin" ]; then
    LAUNCHER="$HOME/Desktop/Commonplace.command"
    printf '#!/bin/bash\nexec "%s/scripts/start.sh"\n' "$DIR" > "$LAUNCHER"
    chmod +x "$LAUNCHER"
    say "Added Commonplace to your Desktop. Double-click it to start."
  else
    APPS="$HOME/.local/share/applications"
    mkdir -p "$APPS"
    cat > "$APPS/commonplace.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Commonplace
Comment=Peer-to-peer documents
Exec="$DIR/scripts/start.sh"
Terminal=false
Categories=Office;
EOF
    say "Added Commonplace to your applications menu."
  fi
fi

say "Done. To start Commonplace any time:"
printf '  %s/scripts/start.sh\n\n' "$DIR"
printf 'If your computer asks whether Commonplace may accept network connections, allow it,\nor other people\x27s computers can\x27t reach yours.\n\n'
