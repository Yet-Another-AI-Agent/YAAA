#!/usr/bin/env bash
#
# Boots the YAAA Electron UI with a consistent Node version and native
# modules rebuilt for Electron's ABI.
#
# better-sqlite3 is a native module: `npm rebuild` builds it against
# whatever `node` binary is currently active, but Electron bundles its own
# Node with a different ABI (NODE_MODULE_VERSION) than your system Node.
# Mixing the two is exactly the
#   "was compiled against a different Node.js version ... NODE_MODULE_VERSION"
# crash. This script always rebuilds better-sqlite3 for Electron right
# before launching it, so `npm start` just works regardless of what last
# rebuilt the module.
#
# Note: `npm test` / `npm run build` run under the system Node (vitest/tsc),
# not Electron. If you see the same ABI error there after running this
# script, run `npm rebuild better-sqlite3` to rebuild it back for the
# system Node — the two targets need different builds of the same module.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  if ! nvm use; then
    echo "Node $(tr -d '[:space:]' < .nvmrc) is not installed; installing it with nvm..."
    nvm install
    nvm use
  fi
else
  required_node="v$(tr -d '[:space:]' < .nvmrc)"
  current_node="$(node --version 2>/dev/null || true)"
  if [ "$current_node" != "$required_node" ]; then
    echo "Expected Node $required_node from .nvmrc, but found ${current_node:-no Node installation}." >&2
    echo "Install nvm or activate the pinned Node version before running this launcher." >&2
    exit 1
  fi
fi

npm install
npx electron-rebuild -f -w better-sqlite3 --module-dir apps/ui
sudo npm run dev:ui
