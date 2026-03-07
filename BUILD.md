# Building Koryphaios Desktop

This guide covers building the Koryphaios desktop application for all supported platforms.

## Table of Contents

- [Quick Build](#quick-build)
- [Platform-Specific Builds](#platform-specific-builds)
  - [Windows](#windows)
  - [macOS](#macos)
  - [Linux](#linux)
- [Automated CI/CD Builds](#automated-cicd-builds)
- [Cross-Compilation](#cross-compilation)
- [Troubleshooting](#troubleshooting)

## Quick Build

### Prerequisites

All platforms require:
- [Bun](https://bun.sh) 1.0+
- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (latest stable)

### One-Command Build

From the project root:

```bash
# Build for your current platform
bun run build:desktop
```

This will:
1. Install dependencies
2. Build the frontend (static export)
3. Build the Tauri desktop app
4. Output packages to `desktop/src-tauri/target/release/bundle/`

## Platform-Specific Builds

### Windows

#### Prerequisites

1. **Install Visual Studio Build Tools** (or full Visual Studio)
   - Download from: https://visualstudio.microsoft.com/downloads/
   - Install "Desktop development with C++" workload

2. **Install Rust** (if not already installed):
   ```powershell
   # In PowerShell
   winget install Rustlang.Rustup
   ```

#### Build

```powershell
# From project root in PowerShell or CMD
bun run build:desktop:windows

# Or with options:
scripts\build-desktop-windows.bat release
```

#### Output

- **MSI Installer**: `desktop/src-tauri/target/release/bundle/msi/Koryphaios_0.1.0_x64_en-US.msi`
- **NSIS Installer**: `desktop/src-tauri/target/release/bundle/nsis/Koryphaios_0.1.0_x64-setup.exe`

### macOS

#### Prerequisites

1. **Install Xcode Command Line Tools**:
   ```bash
   xcode-select --install
   ```

2. **Install Rust** (if not already installed):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

#### Build

```bash
# From project root

# Universal binary (recommended - works on Intel and Apple Silicon)
bun run build:desktop:macos

# Or manually with architecture options:
scripts/build-desktop-macos.sh release universal

# Intel only
scripts/build-desktop-macos.sh release x86_64

# Apple Silicon only
scripts/build-desktop-macos.sh release aarch64
```

#### Output

- **Universal DMG**: `desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Koryphaios_0.1.0_universal.dmg`
- **Universal App**: `desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Koryphaios.app`

### Linux

#### Prerequisites

**Debian/Ubuntu:**
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgtk-3-dev \
  libayatana-appindicator3-dev
```

**Fedora/RHEL:**
```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  patchelf
```

**Arch Linux:**
```bash
sudo pacman -S \
  webkit2gtk-4.1 \
  libappindicator-gtk3 \
  librsvg \
  patchelf
```

#### Build

```bash
# From project root
bun run build:desktop:linux

# Or manually:
scripts/build-desktop-linux.sh release x86_64

# For ARM64 (requires cross-compilation setup):
scripts/build-desktop-linux.sh release aarch64
```

#### Output

- **DEB Package**: `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/koryphaios_0.1.0_amd64.deb`
- **RPM Package**: `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/rpm/koryphaios-0.1.0-1.x86_64.rpm`
- **AppImage**: `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/koryphaios_0.1.0_amd64.AppImage`

## Automated CI/CD Builds

### GitHub Actions

The project includes a comprehensive GitHub Actions workflow (`.github/workflows/build-desktop.yml`) that automatically:

1. **Builds on every push to main**
2. **Creates releases on tags** (e.g., `v1.0.0`)
3. **Supports manual triggers** via workflow_dispatch

### Triggering a Release

```bash
# Create a version tag
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

GitHub Actions will:
- Build for Windows (x86_64)
- Build for macOS (x86_64, aarch64, and universal)
- Build for Linux (x86_64 and aarch64)
- Upload all artifacts to the GitHub Release

### Downloading CI Artifacts

1. Go to the Actions tab in GitHub
2. Select the "Build Desktop Apps" workflow
3. Click on a completed run
4. Download artifacts from the bottom of the page

## Cross-Compilation

### From macOS

macOS can build for both Intel and Apple Silicon:

```bash
# Build universal binary (native on both architectures)
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin
scripts/build-desktop-macos.sh release universal
```

### From Linux x86_64 to ARM64

1. Install cross-compiler:
```bash
# Debian/Ubuntu
sudo apt install gcc-aarch64-linux-gnu

# Fedora
sudo dnf install gcc-aarch64-linux-gnu
```

2. Set environment and build:
```bash
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
scripts/build-desktop-linux.sh release aarch64
```

### Docker-based Cross-Compilation

For consistent builds across platforms, you can use Docker:

```dockerfile
# Dockerfile.build
FROM rust:latest

RUN apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    nodejs \
    npm

# Install Bun
RUN npm install -g bun

WORKDIR /build
COPY . .

RUN bun install
RUN bun run build:desktop
```

## Troubleshooting

### Common Issues

#### Windows: "linker not found"

**Solution:** Install Visual Studio Build Tools with C++ workload

```powershell
# Or use winget
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools"
```

#### macOS: "App is damaged"

**Solution:** Remove quarantine attribute

```bash
xattr -cr /Applications/Koryphaios.app
```

#### Linux: "error while loading shared libraries"

**Solution:** Install missing dependencies

```bash
# Check missing libraries
ldd ./koryphaios | grep "not found"

# Install WebKit
sudo apt install libwebkit2gtk-4.1-0

# Install AppImage dependencies
sudo apt install libfuse2
```

#### All Platforms: "failed to run custom build command"

**Solution:** Clean and rebuild

```bash
# Clean Tauri build
cd desktop/src-tauri
cargo clean

# Rebuild from project root
cd ../..
bun run build:desktop
```

### Build Logs

Enable verbose logging:

```bash
# Rust build logs
RUST_LOG=debug bun run build:desktop

# Tauri verbose
bun run tauri build --verbose
```

### Getting Help

1. Check [Tauri documentation](https://tauri.app/v1/guides/)
2. Review build logs in `desktop/src-tauri/target/`  
3. Open an issue with:
   - Platform and version
   - Build command used
   - Full error output
   - `tauri info` output

## Configuration

### Customizing the Build

Edit `desktop/src-tauri/tauri.conf.json` to customize:

```json
{
  "bundle": {
    "icon": ["icons/32x32.png", "icons/icon.icns"],
    "category": "DeveloperTool",
    "shortDescription": "Your description",
    "longDescription": "Your longer description"
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `BUILD_MODE` | Set to `static` for Tauri builds |
| `NODE_ENV` | `production` for optimized builds |
| `TAURI_SIGNING_PRIVATE_KEY` | For updater signing |
| `CARGO_TARGET_*_LINKER` | Cross-compilation linker |

## Next Steps

After building:

1. **Test the application** on target platforms
2. **Code sign** the binaries (see desktop/README.md)
3. **Distribute** via your preferred channels
4. **Set up auto-updater** (requires signing)

For more details, see the [desktop README](desktop/README.md).
