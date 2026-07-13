#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"
REQUIRED_NODE="v${NODE_VERSION}"

info() {
  printf '[YAAA] %s\n' "$1"
}

fail() {
  printf '[YAAA] %s\n' "$1" >&2
  exit 1
}

load_nvm() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.nvm/nvm.sh"
    return 0
  fi
  return 1
}

attempt_node_install() {
  info "Attempting to install Node.js prerequisites..."
  if load_nvm; then
    nvm install "$NODE_VERSION"
    nvm use "$NODE_VERSION"
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    info "Homebrew found. Installing Node.js with brew."
    brew install node
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    info "apt-get found. Installing nodejs and npm with apt."
    sudo apt-get update
    sudo apt-get install -y nodejs npm
    return 0
  fi

  return 1
}

if load_nvm; then
  info "Using Node.js ${NODE_VERSION} from .nvmrc."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
elif ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  attempt_node_install || fail "Could not install Node.js automatically. Install Node.js ${NODE_VERSION}+ and npm, then run this script again."
fi

CURRENT_NODE="$(node --version 2>/dev/null || true)"
if [ "$CURRENT_NODE" != "$REQUIRED_NODE" ]; then
  info "Expected ${REQUIRED_NODE}; found ${CURRENT_NODE:-no Node}. Continuing, but the pinned version is recommended."
fi

command -v npm >/dev/null 2>&1 || fail "npm is required but was not found."

info "Installing JavaScript dependencies..."
npm install

info "Rebuilding Electron native modules..."
npx electron-rebuild -f -w better-sqlite3 --module-dir apps/ui

info "Starting YAAA..."
npm run dev:ui
