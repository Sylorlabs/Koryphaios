# Koryphaios Desktop App

Cross-platform desktop application for Koryphaios built with Tauri v2.

## Supported Platforms

| Platform | Architectures | Package Formats |
|----------|--------------|-----------------|
| **Windows** | x86_64 | MSI, NSIS (.exe) |
| **macOS** | x86_64, ARM64 (M1/M2/M3), Universal | DMG, .app bundle |
| **Linux** | x86_64, ARM64 | DEB, RPM, AppImage |

## Quick Start

### Development

```bash
# From project root - starts backend, frontend, and Tauri dev window
bun run dev:desktop
```

### Build for Current Platform

```bash
# From project root - builds for your current platform
bun run build:desktop

# Or use platform-specific scripts:
bun run build:desktop:windows  # Windows only
bun run build:desktop:macos    # macOS only  
bun run build:desktop:linux    # Linux only
```

## Prerequisites

### All Platforms

- [Bun](https://bun.sh) 1.0+ (runtime and package manager)
- [Node.js](https://nodejs.org) 18+ (for compatibility)
- [Rust](https://rustup.rs) (latest stable)

Install Rust:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Platform-Specific Requirements

#### Windows

**Required:**
- Microsoft Visual C++ Redistributable
- Windows SDK (installed with Visual Studio or Build Tools)

**Install Visual Studio Build Tools:**
1. Download from: https://visualstudio.microsoft.com/downloads/
2. Install "Desktop development with C++" workload
3. Or use the standalone Build Tools

#### macOS

**Required:**
- Xcode Command Line Tools

```bash
xcode-select --install
```

**Optional (for code signing):**
- Apple Developer account
- Valid signing certificate

#### Linux

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

## Build Configurations

### Debug Build

Faster builds, includes debugging symbols:

```bash
# Windows
scripts/build-desktop-windows.bat debug

# macOS
scripts/build-desktop-macos.sh debug x86_64

# Linux
scripts/build-desktop-linux.sh debug x86_64
```

### Release Build

Optimized builds for distribution:

```bash
# Windows
scripts/build-desktop-windows.bat release

# macOS (Universal binary - recommended)
scripts/build-desktop-macos.sh release universal

# macOS (Intel only)
scripts/build-desktop-macos.sh release x86_64

# macOS (Apple Silicon only)
scripts/build-desktop-macos.sh release aarch64

# Linux (x86_64)
scripts/build-desktop-linux.sh release x86_64

# Linux (ARM64 - requires cross-compilation setup)
scripts/build-desktop-linux.sh release aarch64
```

## Output Locations

### Windows
```
desktop/src-tauri/target/release/bundle/msi/*.msi
desktop/src-tauri/target/release/bundle/nsis/*.exe
```

### macOS
```
# Universal binary
desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app

# Architecture-specific
desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/*.dmg
desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
```

### Linux
```
desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb
desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/rpm/*.rpm
desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/*.AppImage
```

## CI/CD Builds

GitHub Actions automatically builds for all platforms on every push to `main` and on tagged releases.

### Triggering a Release Build

1. Create and push a tag:
```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

2. GitHub Actions will:
   - Build for Windows (x86_64)
   - Build for macOS (Intel, ARM64, and Universal)
   - Build for Linux (x86_64 and ARM64)
   - Upload artifacts to the release

### Manual Workflow Dispatch

You can also trigger builds manually from the GitHub Actions tab with the "Build Desktop Apps" workflow.

## Code Signing

### Windows

For production releases, sign your executables:

```powershell
# Using signtool (Windows SDK)
signtool sign /f certificate.pfx /p password /tr http://timestamp.digicert.com /td sha256 /fd sha256 "Koryphaios.exe"
```

Or set the certificate thumbprint in `tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_THUMBPRINT"
    }
  }
}
```

### macOS

Sign and notarize for distribution outside the App Store:

```bash
# Sign the app
codesign --force --deep --sign "Developer ID Application: Your Name" Koryphaios.app

# Create DMG
create-dmg \
  --volname "Koryphaios" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --app-drop-link 600 185 \
  "Koryphaios.dmg" \
  "Koryphaios.app"
```

### Linux

No code signing required. GPG signing for packages is optional:

```bash
# Sign DEB package
dpkg-sig --sign builder *.deb

# Sign RPM package
rpm --addsign *.rpm
```

## Architecture

### Frontend (WebView)
- SvelteKit with static adapter for Tauri builds
- Communicates with backend via HTTP API and WebSocket
- Uses Tauri's API for native features (shell, notifications, dialogs)

### Backend (Rust)
- Tauri v2 runtime
- System tray integration
- Native API commands for frontend

### API Communication
The frontend communicates with the backend via:
- **Tauri Desktop**: Uses full backend URLs (`http://127.0.0.1:3000/api/*`)
- The backend runs locally on the user's machine

See `frontend/src/lib/utils/api-url.ts` for implementation details.

## Configuration

### Backend Port
The backend port is determined by (in order of priority):
1. `KORYPHAIOS_PORT` environment variable
2. `server.port` in `koryphaios.json`
3. Default: 3000

### Tauri Configuration
Edit `desktop/src-tauri/tauri.conf.json` to customize:
- Window size and behavior
- Security policies (CSP)
- Bundle settings
- Platform-specific options

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILD_MODE` | Set to `static` for Tauri builds |
| `NODE_ENV` | Set to `production` for release builds |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for updater signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for signing key |
| `CARGO_TARGET_*_LINKER` | Cross-compilation linker override |

## Troubleshooting

### Windows

**Build fails with linker errors:**
- Install Visual Studio Build Tools with C++ workload
- Ensure `cl.exe` is in your PATH

**App won't start:**
- Install Visual C++ Redistributable
- Check Windows Event Viewer for errors

**WebView2 not found:**
- The installer will prompt to install WebView2 Runtime
- Or download from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### macOS

**"App is damaged" warning:**
```bash
xattr -cr /Applications/Koryphaios.app
```

**Code signing issues:**
```bash
# For local builds, disable signing
export CSC_IDENTITY_AUTO_DISCOVERY=false
```

**Universal binary build fails:**
- Ensure both targets are installed:
```bash
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin
```

### Linux

**WebKit errors:**
```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-0

# Fedora
sudo dnf install webkit2gtk4.1

# Arch
sudo pacman -S webkit2gtk-4.1
```

**AppImage won't run:**
```bash
# Install FUSE 2 (AppImage dependency)
# Debian/Ubuntu
sudo apt install libfuse2

# Fedora
sudo dnf install fuse

# Arch
sudo pacman -S fuse2
```

**Missing libappindicator:**
```bash
# Debian/Ubuntu
sudo apt install libappindicator3-1

# Fedora
sudo dnf install libappindicator-gtk3
```

## Cross-Compilation

### Linux ARM64 from x86_64

1. Install cross-compiler:
```bash
# Debian/Ubuntu
sudo apt install gcc-aarch64-linux-gnu

# Fedora
sudo dnf install gcc-aarch64-linux-gnu
```

2. Set linker environment variable:
```bash
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
```

3. Build:
```bash
scripts/build-desktop-linux.sh release aarch64
```

### macOS Universal Binary

Tauri automatically creates universal binaries when using `--target universal-apple-darwin`:

```bash
bun run tauri build --target universal-apple-darwin
```

This creates a single `.app` bundle that runs natively on both Intel and Apple Silicon Macs.

## Development Tips

### Hot Reload
During development (`bun run dev:desktop`), changes to:
- Frontend code: Auto-reload via Vite HMR
- Rust code: Requires Tauri restart

### Debugging Rust
```bash
# Run with debug output
cd desktop
RUST_LOG=debug bun run tauri dev
```

### Inspecting WebView
- **Windows**: Press F12 or Ctrl+Shift+I
- **macOS**: Press Cmd+Option+I
- **Linux**: Press Ctrl+Shift+I

## License

Private - All rights reserved.
