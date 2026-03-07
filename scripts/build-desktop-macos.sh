#!/bin/bash
#
# macOS Desktop Build Script for Koryphaios
# Usage: ./build-desktop-macos.sh [debug|release] [x86_64|aarch64|universal]
#

set -e

BUILD_MODE="${1:-release}"
ARCH="${2:-universal}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo -e "${BLUE}===========================================${NC}"
echo -e "${BLUE}  KORYPHAIOS macOS DESKTOP BUILD${NC}"
echo -e "${BLUE}  Mode: ${BUILD_MODE}${NC}"
echo -e "${BLUE}  Architecture: ${ARCH}${NC}"
echo -e "${BLUE}===========================================${NC}"
echo

# Check for prerequisites
check_prereq() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}ERROR: $1 is not installed or not in PATH${NC}"
        return 1
    fi
}

echo "Checking prerequisites..."
check_prereq bun || { echo "Please install Bun from https://bun.sh"; exit 1; }
check_prereq cargo || { echo "Please install Rust from https://rustup.rs"; exit 1; }

# Check for Xcode Command Line Tools on macOS
if ! xcode-select -p &> /dev/null; then
    echo -e "${YELLOW}WARNING: Xcode Command Line Tools not found${NC}"
    echo "Install with: xcode-select --install"
fi

echo -e "${GREEN}✓ Prerequisites check passed${NC}"
echo

# Install dependencies
echo -e "${YELLOW}[1/4] Installing dependencies...${NC}"
cd "${PROJECT_ROOT}"
bun install --frozen-lockfile

# Setup Rust targets for macOS
echo -e "${YELLOW}[2/4] Setting up Rust targets...${NC}"
case "${ARCH}" in
    x86_64)
        rustup target add x86_64-apple-darwin
        TARGET="x86_64-apple-darwin"
        ;;
    aarch64)
        rustup target add aarch64-apple-darwin
        TARGET="aarch64-apple-darwin"
        ;;
    universal)
        rustup target add x86_64-apple-darwin
        rustup target add aarch64-apple-darwin
        TARGET="universal-apple-darwin"
        ;;
    *)
        echo -e "${RED}ERROR: Unknown architecture: ${ARCH}${NC}"
        echo "Supported: x86_64, aarch64, universal"
        exit 1
        ;;
esac

# Build frontend
echo -e "${YELLOW}[3/4] Building frontend...${NC}"
cd "${PROJECT_ROOT}/frontend"
export BUILD_MODE=static
export NODE_ENV=production
bun run build

# Build Tauri app
echo -e "${YELLOW}[4/4] Building Tauri app for macOS (${ARCH})...${NC}"
cd "${PROJECT_ROOT}/desktop"

if [ "${BUILD_MODE}" = "debug" ]; then
    if [ "${ARCH}" = "universal" ]; then
        echo -e "${YELLOW}Note: Universal binaries require release mode for proper signing${NC}"
        bun run tauri build --target universal-apple-darwin --debug
    else
        bun run tauri build --target "${TARGET}" --debug
    fi
else
    if [ "${ARCH}" = "universal" ]; then
        bun run tauri build --target universal-apple-darwin
    else
        bun run tauri build --target "${TARGET}"
    fi
fi

echo
echo -e "${GREEN}===========================================${NC}"
echo -e "${GREEN}  BUILD SUCCESSFUL!${NC}"
echo -e "${GREEN}===========================================${NC}"
echo
echo "Output locations:"
if [ "${ARCH}" = "universal" ]; then
    echo "  - DMG: desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/"
    echo "  - App Bundle: desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/"
else
    echo "  - DMG: desktop/src-tauri/target/${TARGET}/release/bundle/dmg/"
    echo "  - App Bundle: desktop/src-tauri/target/${TARGET}/release/bundle/macos/"
fi
echo

# Code signing information
if [ "${BUILD_MODE}" = "release" ]; then
    echo -e "${YELLOW}Code Signing Notes:${NC}"
    echo "  - For distribution, you may need to sign the app:"
    echo "    codesign --force --deep --sign 'Developer ID' Koryphaios.app"
    echo "  - For local testing, you can bypass Gatekeeper:"
    echo "    xattr -cr /Applications/Koryphaios.app"
    echo
fi
