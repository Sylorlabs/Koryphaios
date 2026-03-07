@echo off
REM Windows Desktop Build Script for Koryphaios
REM Usage: build-desktop-windows.bat [debug|release]

setlocal EnableDelayedExpansion

set "BUILD_MODE=%~1"
if "!BUILD_MODE!"=="" set "BUILD_MODE=release"

echo ===========================================
echo   KORYPHAIOS WINDOWS DESKTOP BUILD
echo   Mode: !BUILD_MODE!
echo ===========================================
echo.

REM Check for prerequisites
where bun >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Bun is not installed or not in PATH
    echo Please install Bun from https://bun.sh
    exit /b 1
)

where cargo >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust/Cargo is not installed or not in PATH
    echo Please install Rust from https://rustup.rs
    exit /b 1
)

REM Get project root
set "PROJECT_ROOT=%~dp0.."
cd /d "!PROJECT_ROOT!"

echo [1/3] Installing dependencies...
bun install --frozen-lockfile
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies
    exit /b 1
)

echo.
echo [2/3] Building frontend...
cd frontend
set "BUILD_MODE=static"
set "NODE_ENV=production"
bun run build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Frontend build failed
    exit /b 1
)
cd ..

echo.
echo [3/3] Building Tauri app for Windows...
cd desktop

if "!BUILD_MODE!"=="debug" (
    bun run tauri build --debug
) else (
    bun run tauri build
)

if %ERRORLEVEL% neq 0 (
    echo ERROR: Tauri build failed
    exit /b 1
)

cd ..

echo.
echo ===========================================
echo   BUILD SUCCESSFUL!
echo ===========================================
echo.
echo Output locations:
echo   - MSI Installer: desktop\src-tauri\target\release\bundle\msi\
echo   - NSIS Installer: desktop\src-tauri\target\release\bundle\nsis\
echo   - Executable: desktop\src-tauri\target\release\
echo.

endlocal
