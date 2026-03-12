#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <owner> <repo> <version> <sha256>"
  echo "Example: $0 your-org deliveryhero-claude-proxy-monitor 0.1.0 abcdef123..."
  exit 1
fi

OWNER="$1"
REPO="$2"
VERSION="$3"
SHA256="$4"

mkdir -p packaging/homebrew/Casks

CASK_PATH="packaging/homebrew/Casks/dh-claude-proxy-monitor.rb"

cat > "$CASK_PATH" <<EOF
cask "dh-claude-proxy-monitor" do
  version "${VERSION}"
  sha256 "${SHA256}"

  url "https://github.com/${OWNER}/${REPO}/releases/download/v#{version}/DH%20Claude%20Proxy%20Monitor-#{version}-arm64.dmg"
  name "DH Claude Proxy Monitor"
  desc "DeliveryHero proxy usage monitor for Claude Code"
  homepage "https://github.com/${OWNER}/${REPO}"

  app "DH Claude Proxy Monitor.app"
end
EOF

echo "Wrote ${CASK_PATH}"
