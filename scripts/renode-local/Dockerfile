FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

# Headless portable .NET runtime dependencies; no desktop, USB, TAP, or debug probe.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgcc-s1 libstdc++6 libicu72 libssl3 \
    libgssapi-krb5-2 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home runner

WORKDIR /workspace
RUN chown runner:runner /workspace
COPY --chown=runner:runner . scripts/renode-local/
USER runner
RUN python scripts/renode-local/renode.py install
CMD ["python", "scripts/renode-local/renode.py", "smoke"]
