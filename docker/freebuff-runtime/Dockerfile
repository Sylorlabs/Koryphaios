# Build context must be this directory, never the repository or a user's HOME.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS download
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /download
# Official npm freebuff 0.0.173 launcher stageBinary() release URLs. The x64
# baseline avoids AVX2 requirements; ARM64 is native on Apple Silicon Docker.
RUN target="${TARGETARCH:-$(dpkg --print-architecture)}"; \
 if [ "$target" = "arm64" ]; then \
      url='https://codebuff.com/api/releases/download/0.2.16/freebuff-linux-arm64.tar.gz'; \
      sha='3d5e9049da25d176eedd8193aef12c1c485096c6a42d3927c3e183c38c62adc1'; \
    else \
      url='https://codebuff.com/api/releases/download/0.2.16/freebuff-linux-x64-baseline.tar.gz'; \
      sha='bc6fce99050823b9fdcc9b64a9993525b0c478c45b3bd4460cbab55d9afaf3f3'; \
    fi \
 && curl -fsSL --proto '=https' --proto-redir '=https' "$url" -o freebuff.tar.gz \
 && echo "$sha  freebuff.tar.gz" | sha256sum -c - \
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
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap tmux ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/kory
COPY --from=download /download/freebuff/ /opt/kory/freebuff/
COPY --from=download /download/bun /opt/kory/bun
RUN chmod 755 /opt/kory/freebuff/freebuff /opt/kory/bun \
 && mkdir /tmp/version-home \
 && HOME=/tmp/version-home /opt/kory/freebuff/freebuff --version | grep -F '0.2.16' \
 && /opt/kory/bun --version | grep -Fx '1.3.14' \
 && rm -rf /tmp/version-home
LABEL org.koryphaios.freebuff.version="0.2.16" org.koryphaios.freebuff.wrapper-version="0.0.173"
ENV PATH=/opt/kory:/usr/local/bin:/usr/bin:/bin
# Default is unprivileged. Runtime's trusted bwrap controller overrides this,
# then irreversibly drops CLI identity/capabilities inside the sandbox (see README).
USER 65534:65534
CMD ["sleep", "infinity"]
