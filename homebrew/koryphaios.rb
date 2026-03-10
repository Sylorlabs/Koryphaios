# Koryphaios Homebrew Formula
# AI Agent Orchestration Dashboard
# 
# To install:
#   brew tap sylorlabs/tap
#   brew install koryphaios
#
# To upgrade:
#   brew update
#   brew upgrade koryphaios

class Koryphaios < Formula
  desc "AI Agent Orchestration Dashboard"
  homepage "https://koryphaios.com"
  version "0.2.0"

  # Stable releases
  stable do
    if OS.mac? && Hardware::CPU.arm?
      url "https://github.com/sylorlabs/koryphaios/releases/download/v0.2.0/Koryphaios_0.2.0_aarch64.dmg"
      sha256 "PLACEHOLDER_SHA256_AARCH64"
    elsif OS.mac? && Hardware::CPU.intel?
      url "https://github.com/sylorlabs/koryphaios/releases/download/v0.2.0/Koryphaios_0.2.0_x64.dmg"
      sha256 "PLACEHOLDER_SHA256_X64"
    elsif OS.linux?
      url "https://github.com/sylorlabs/koryphaios/releases/download/v0.2.0/koryphaios_0.2.0_amd64.AppImage"
      sha256 "PLACEHOLDER_SHA256_APPIMAGE"
    end
  end

  # Head build from source (for development)
  head do
    url "https://github.com/sylorlabs/koryphaios.git", branch: "main"
    depends_on "rust" => :build
    depends_on "node" => :build
    depends_on "bun" => :build
  end

  # Dependencies for head builds
  depends_on "rust" => :build if build.head?
  depends_on "node" => :build if build.head?

  def install
    if build.head?
      # Build from source
      system "bun", "install"
      system "bun", "run", "build:desktop"
      
      if OS.mac?
        prefix.install "desktop/src-tauri/target/release/bundle/macos/Koryphaios.app"
        bin.install_symlink prefix/"Koryphaios.app/Contents/MacOS/koryphaios-desktop" => "koryphaios"
      else
        bin.install "desktop/src-tauri/target/release/bundle/appimage/koryphaios-0.2.0.AppImage" => "koryphaios"
      end
    else
      # Install from pre-built binary
      if OS.mac?
        # Mount the DMG and copy the app
        system "hdiutil", "attach", "-nobrowse", "-quiet", "Koryphaios_#{version}_aarch64.dmg"
        prefix.install "/Volumes/Koryphaios/Koryphaios.app"
        system "hdiutil", "detach", "-quiet", "/Volumes/Koryphaios"
        bin.install_symlink prefix/"Koryphaios.app/Contents/MacOS/koryphaios-desktop" => "koryphaios"
      else
        # Linux AppImage
        bin.install "koryphaios_#{version}_amd64.AppImage" => "koryphaios"
      end
    end
  end

  def caveats
    <<~EOS
      Koryphaios has been installed!
      
      To start Koryphaios:
        koryphaios
      
      Or launch from Applications folder on macOS.
      
      For updates, run:
        brew update && brew upgrade koryphaios
      
      Or use the in-app updater:
        View → Check for Updates
      
      Documentation: https://koryphaios.com/docs
      Changelog: https://koryphaios.com/changelog
    EOS
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"koryphaios", :exist?
    assert_predicate bin/"koryphaios", :executable?
    
    # Test version output (if the app supports --version)
    # system "#{bin}/koryphaios", "--version"
  end
end
