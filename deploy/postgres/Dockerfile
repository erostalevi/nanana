# Postgres 16 + WAL-G, archiving to S3 with the EC2 instance role (no static keys).
FROM debian:bookworm-slim AS walg
ARG TARGETARCH
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256_AMD64=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9
ARG WALG_SHA256_ARM64=072eb4a4a119f817e1fa888c64a776b01e3453b2e0d967a67d149adb18fde652
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64;   sha="$WALG_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sha="$WALG_SHA256_ARM64" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /wal-g "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${arch}"; \
    echo "${sha}  /wal-g" | sha256sum -c -; \
    chmod 0755 /wal-g

FROM postgres:16-bookworm
# The official image ships no CA bundle; WAL-G needs it to verify S3's TLS certificate
# (without it every request fails certificate verification and WAL-G retries forever).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=walg /wal-g /usr/local/bin/wal-g
COPY nanana.conf /etc/postgresql/nanana.conf
COPY nanana-backup /usr/local/bin/nanana-backup
RUN chmod 0755 /usr/local/bin/nanana-backup /usr/local/bin/wal-g

# WAL-G reads these from the environment (set in docker-compose.yml):
#   WALG_S3_PREFIX, AWS_REGION, PGUSER, PGHOST
ENV WALG_COMPRESSION_METHOD=lz4 \
    PGHOST=/var/run/postgresql

CMD ["postgres", "-c", "config_file=/etc/postgresql/nanana.conf"]
