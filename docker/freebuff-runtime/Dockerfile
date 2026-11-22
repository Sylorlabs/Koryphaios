# Build context must be this directory, never the repository or a user's HOME.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS download
ARG TARGETARCH
ARG FREEBUFF_VERSION
ARG FREEBUFF_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /download
# Official npm freebuff launcher stageBinary() release URLs. The x64
# baseline avoids AVX2 requirements; ARM64 is native on Apple Silicon Docker.
# Kory tracks the latest release like the official launcher. A known archive
# hash is verified; an unknown version is trust-on-first-use (the launcher
# itself verifies no hash), and the downloaded hash is recorded into the image.
RUN case "$FREEBUFF_VERSION" in \
      '') echo 'FREEBUFF_VERSION build arg is required' >&2; exit 1;; \
    esac; \
    echo "$FREEBUFF_VERSION" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$' \
      || { echo 'FREEBUFF_VERSION must be a numeric dotted-triplet' >&2; exit 1; }; \
    target="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    if [ "$target" = "arm64" ]; then \
      file='freebuff-linux-arm64.tar.gz'; \
    else \
      file='freebuff-linux-x64-baseline.tar.gz'; \
    fi \
 && curl -fsSL --proto '=https' --proto-redir '=https' \
      "https://codebuff.com/api/releases/download/${FREEBUFF_VERSION}/${file}" -o freebuff.tar.gz \
 && if [ -n "$FREEBUFF_SHA256" ]; then echo "$FREEBUFF_SHA256  freebuff.tar.gz" | sha256sum -c -; fi \
 && sha256sum freebuff.tar.gz | cut -d' ' -f1 > ARCHIVE_SHA256 \
 && mkdir freebuff && tar -xzf freebuff.tar.gz -C freebuff
RUN target="${TARGETARCH:-$(dpkg --print-architecture)}"; \
 if [ "$target" = "arm64" ]; then \
      url='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip'; \
      sha='a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b'; \
    else \
      url='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip'; \
      sha='a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7'; \
    fi \
 && curl -fsSL --proto '=https' --proto-redir '=https' "$url" -o bun.zip \
 && echo "$sha  bun.zip" | sha256sum -c - \
 && unzip bun.zip \
 && find /download -type f -name bun -exec cp {} /download/bun \; \
 && test -x /download/bun
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ARG FREEBUFF_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap tmux ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/kory
COPY --from=download /download/freebuff/ /opt/kory/freebuff/
COPY --from=download /download/ARCHIVE_SHA256 /opt/kory/freebuff/ARCHIVE_SHA256
COPY --from=download /download/bun /opt/kory/bun
RUN chmod 755 /opt/kory/freebuff/freebuff /opt/kory/bun \
 && mkdir /tmp/version-home \
 && HOME=/tmp/version-home /opt/kory/freebuff/freebuff --version | grep -F "$FREEBUFF_VERSION" \
 && /opt/kory/bun --version | grep -Fx '1.3.14' \
 && rm -rf /tmp/version-home
LABEL org.koryphaios.freebuff.version="${FREEBUFF_VERSION}"
ENV PATH=/opt/kory:/usr/local/bin:/usr/bin:/bin
# Default is unprivileged. Runtime's trusted bwrap controller overrides this,
# then irreversibly drops CLI identity/capabilities inside the sandbox (see README).
USER 65534:65534
CMD ["sleep", "infinity"]
