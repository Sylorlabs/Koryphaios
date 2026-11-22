# A Linux native evaluation runtime: a real window server (Xvfb), a real GTK window, and no
# access to the operator's desktop. The Tauri fixture builds and runs entirely inside this image.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl ca-certificates git file \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
      libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
      xvfb x11-utils xdotool imagemagick python3 dbus-x11 \
 && rm -rf /var/lib/apt/lists/*

# Tauri v2 needs a modern stable toolchain; bookworm's packaged rustc is too old.
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
 && rustc --version && cargo --version

WORKDIR /work
