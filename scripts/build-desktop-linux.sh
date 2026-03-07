#!/bin/bash
#
# Linux Desktop Build Script for Koryphaios
# Usage: ./build-desktop-linux.sh [debug|release] [x86_64|aarch64]
#

set -e

BUILD_MODE="${1:-release}"
ARCH="${2:-x86_64}"

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
echo -e "${BLUE}  KORYPHAIOS LINUX DESKTOP BUILD${NC}"
echo -e "${BLUE}  Mode: ${BUILD_MODE}${NC}"
echo -e "${BLUE}  Architecture: ${ARCH}${NC}"
echo -e "${BLUE}===========================================${NC}"
echo

# Detect distribution
 detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    else
        echo "unknown"
    fi
}

DISTRO=$(detect_distro)
echo "Detected distribution: ${DISTRO}"

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

# Check for required libraries
echo "Checking system libraries..."
case "${DISTRO}" in
    ubuntu|debian)
        if ! dpkg -l | grep -q libwebkit2gtk-4.1-dev; then
            echo -e "${YELLOW}WARNING: libwebkit2gtk-4.1-dev not found${NC}"
            echo "Install with: sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf"
        fi
        ;;
    fedora|rhel|centos)
        if ! rpm -qa | grep -q webkit2gtk4.1-devel; then
            echo -e "${YELLOW}WARNING: webkit2gtk4.1-devel not found${NC}"
            echo "Install with: sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel patchelf"
        fi
        ;;
    arch|manjaro)
        if ! pacman -Q webkit2gtk-4.1 &> /dev/null; then
            echo -e "${YELLOW}WARNING: webkit2gtk-4.1 not found${NC}"
            echo "Install with: sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg patchelf"
        fi
        ;;
esac

echo -e "${GREEN}✓ Prerequisites check passed${NC}"
echo

# Install dependencies
echo -e "${YELLOW}[1/4] Installing dependencies...${NC}"
cd "${PROJECT_ROOT}"
bun install --frozen-lockfile

# Setup Rust targets for Linux
echo -e "${YELLOW}[2/4] Setting up Rust targets...${NC}"
case "${ARCH}" in
    x86_64)
        rustup target add x86_64-unknown-linux-gnu
        TARGET="x86_64-unknown-linux-gnu"
        ;;
    aarch64)
        rustup target add aarch64-unknown-linux-gnu
        TARGET="aarch64-unknown-linux-gnu"
        # Install cross-compilation tools if needed
        if [ "$(uname -m)" != "aarch64" ]; then
            echo -e "${YELLOW}Cross-compiling for ARM64 on x86_64 host${NC}"
            case "${DISTRO}" in
                ubuntu|debian)
                    if ! command -v aarch64-linux-gnu-gcc &> /dev/null; then
                        echo "Install cross-compiler: sudo apt install gcc-aarch64-linux-gnu"
                        exit 1
                    fi
                    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
                    ;;
                fedora|rhel|centos)
                    if ! command -v aarch64-linux-gnu-gcc &> /dev/null; then
                        echo "Install cross-compiler: sudo dnf install gcc-aarch64-linux-gnu"
                        exit 1
                    fi
                    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
                    ;;
            esac
        fi
        ;;
    *)
        echo -e "${RED}ERROR: Unknown architecture: ${ARCH}${NC}"
        echo "Supported: x86_64, aarch64"
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
echo -e "${YELLOW}[4/4] Building Tauri app for Linux (${ARCH})...${NC}"
cd "${PROJECT_ROOT}/desktop"

if [ "${BUILD_MODE}" = "debug" ]; then
    bun run tauri build --target "${TARGET}" --debug
else
    bun run tauri build --target "${TARGET}"
fi

echo
echo -e "${GREEN}===========================================${NC}"
echo -e "${GREEN}  BUILD SUCCESSFUL!${NC}"
echo -e "${GREEN}===========================================${NC}"
echo
echo "Output locations:"
echo "  - DEB Package: desktop/src-tauri/target/${TARGET}/release/bundle/deb/"
echo "  - RPM Package: desktop/src-tauri/target/${TARGET}/release/bundle/rpm/"
echo "  - AppImage:    desktop/src-tauri/target/${TARGET}/release/bundle/appimage/"
echo

# Installation instructions
echo -e "${BLUE}Installation:${NC}"
echo "  DEB: sudo dpkg -i koryphaios_*.deb"
echo "  RPM: sudo rpm -i koryphaios_*.rpm"
echo "  AppImage: chmod +x koryphaios_*.AppImage && ./koryphaios_*.AppImage"
echo

# Troubleshooting
echo -e "${YELLOW}Troubleshooting:${NC}"
echo "  - If AppImage doesn't run, install libfuse2:"
case "${DISTRO}" in
    ubuntu|debian)
        echo "    sudo apt install libfuse2"
        ;;
    fedora|rhel|centos)
        echo "    sudo dnf install fuse"
        ;;
    arch|manjaro)
        echo "    sudo pacman -S fuse2"
        ;;
esac
echo
