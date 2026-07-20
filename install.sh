#!/bin/bash
# wopr installer — `curl -fsSL https://raw.githubusercontent.com/slay22/wopr/main/install.sh | bash`
#
# Detects the user's OS + architecture, downloads the matching release binary
# from GitHub Releases, and installs it to ~/.local/bin/wopr (configurable).
#
# Re-running is safe: the script overwrites an existing install in place.

set -euo pipefail

REPO="${WOPR_REPO:-slay22/wopr}"
BINARY_NAME="wopr"
INSTALL_DIR="${WOPR_INSTALL_DIR:-$HOME/.local/bin}"

# Pick the asset suffix for this OS/arch
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET_OS=darwin; ASSET_ARCH=arm64 ;;
  Darwin-x86_64) ASSET_OS=darwin; ASSET_ARCH=x64   ;;
  Linux-x86_64)  ASSET_OS=linux;  ASSET_ARCH=x64   ;;
  Linux-aarch64) ASSET_OS=linux;  ASSET_ARCH=arm64 ;;
  *)
    echo "✗ Unsupported platform: $(uname -s)-$(uname -m)"
    echo "  Open an issue at https://github.com/$REPO/issues"
    exit 1
    ;;
esac

ASSET="${BINARY_NAME}-${ASSET_OS}-${ASSET_ARCH}.tar.gz"

# Resolve the latest release tag from the GitHub API
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  echo "✗ Could not determine the latest release of $REPO"
  exit 1
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET"

echo "→ Detected:  $ASSET_OS / $ASSET_ARCH"
echo "→ Version:   $LATEST_TAG"
echo "→ URL:       $DOWNLOAD_URL"
echo "→ Install:   $INSTALL_DIR/$BINARY_NAME"
echo ""

# Download + extract
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$DOWNLOAD_URL" -o "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"
EXTRACTED="$TMP/${BINARY_NAME}-${ASSET_OS}-${ASSET_ARCH}"

if [ ! -f "$EXTRACTED" ]; then
  echo "✗ Downloaded archive did not contain $EXTRACTED"
  exit 1
fi

chmod +x "$EXTRACTED"

# Install (overwriting in place if it exists)
mkdir -p "$INSTALL_DIR"
mv "$EXTRACTED" "$INSTALL_DIR/$BINARY_NAME"

echo "✓ Installed $BINARY_NAME $LATEST_TAG → $INSTALL_DIR/$BINARY_NAME"
echo ""
echo "Make sure $INSTALL_DIR is on your PATH. To verify:"
echo "  $INSTALL_DIR/$BINARY_NAME --version"
