# Quick Build Reference

## One-Line Builds

| Platform | Command |
|----------|---------|
| **Current Platform** | `bun run build:desktop` |
| **Windows** | `bun run build:desktop:windows` or `scripts\build-desktop-windows.bat` |
| **macOS** | `bun run build:desktop:macos` or `scripts/build-desktop-macos.sh` |
| **Linux** | `bun run build:desktop:linux` or `scripts/build-desktop-linux.sh` |

## Build Options

### Debug Build (faster)
```bash
# Windows
scripts/build-desktop-windows.bat debug

# macOS
scripts/build-desktop-macos.sh debug universal

# Linux  
scripts/build-desktop-linux.sh debug x86_64
```

### Release Build (optimized)
```bash
# Windows
scripts/build-desktop-windows.bat release

# macOS Universal
scripts/build-desktop-macos.sh release universal

# Linux x86_64
scripts/build-desktop-linux.sh release x86_64

# Linux ARM64
scripts/build-desktop-linux.sh release aarch64
```

## Output Locations

| Platform | Path |
|----------|------|
| **Windows MSI** | `desktop/src-tauri/target/release/bundle/msi/` |
| **Windows EXE** | `desktop/src-tauri/target/release/bundle/nsis/` |
| **macOS DMG** | `desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/` |
| **macOS App** | `desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/` |
| **Linux DEB** | `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/` |
| **Linux RPM** | `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/rpm/` |
| **Linux AppImage** | `desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/` |

## Prerequisites Check

### Windows
```powershell
# Check prerequisites
where bun
where cargo
# Install Visual Studio Build Tools if missing
```

### macOS
```bash
# Check prerequisites
which bun
which cargo
xcode-select --install  # if needed
```

### Linux
```bash
# Check prerequisites
which bun
which cargo
# Install dependencies if missing
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Common Issues

| Issue | Solution |
|-------|----------|
| Windows: linker error | Install Visual Studio Build Tools with C++ |
| macOS: "App is damaged" | `xattr -cr /Applications/Koryphaios.app` |
| Linux: WebKit error | `sudo apt install libwebkit2gtk-4.1-0` |
| Linux: AppImage won't run | `sudo apt install libfuse2` |

## CI/CD

GitHub Actions builds all platforms automatically:
- On every push to `main`
- On version tags (e.g., `v1.0.0`)
- Manual trigger via Actions tab

Create a release:
```bash
git tag -a v1.0.0 -m "Version 1.0.0"
git push origin v1.0.0
```
