# Build context must be this directory, never the repository or a user's HOME.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS download
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /download
# Official npm freebuff 0.0.173 launcher stageBinary() release URL; baseline avoids AVX2 requirements.
RUN curl -fsSL --proto '=https' --proto-redir '=https' https://codebuff.com/api/releases/download/0.2.12/freebuff-linux-x64-baseline.tar.gz -o freebuff.tar.gz \
 && echo '878e5a7ce680ef760b98cfa0018a6c6d8b8491fd07ce24f2bb22ba7238cd728f  freebuff.tar.gz' | sha256sum -c - \
 && mkdir freebuff && tar -xzf freebuff.tar.gz -C freebuff
RUN curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip -o bun.zip \
 && echo 'a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  bun.zip' | sha256sum -c - \
 && unzip bun.zip
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap tmux ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=download /download/freebuff/ /opt/kory/freebuff/
COPY --from=download /download/bun-linux-x64-baseline/bun /opt/kory/bun
RUN chmod 755 /opt/kory/freebuff/freebuff /opt/kory/bun \
 && mkdir /tmp/version-home \
 && HOME=/tmp/version-home /opt/kory/freebuff/freebuff --version | grep -F '0.2.12' \
 && /opt/kory/bun --version | grep -Fx '1.3.14' \
 && rm -rf /tmp/version-home
LABEL org.koryphaios.freebuff.version="0.2.12" org.koryphaios.freebuff.wrapper-version="0.0.173"
ENV PATH=/opt/kory:/usr/local/bin:/usr/bin:/bin
# Default is unprivileged. Runtime's trusted bwrap controller overrides this,
# then irreversibly drops CLI identity/capabilities inside the sandbox (see README).
USER 65534:65534
CMD ["sleep", "infinity"]
