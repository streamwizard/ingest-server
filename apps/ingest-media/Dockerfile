# Ingest media plane (pure Python + libsrt over ctypes).
#
# Runs on the Hetzner ingest VM via docker/stream-server/docker-compose.yml.
# No GStreamer/PyGObject and no pip dependencies — the relay is libsrt
# recv→send. libsrt comes from the Debian system package and is loaded at
# runtime via ctypes.
FROM debian:trixie-slim AS runner

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# System stack:
#  - python3 : the interpreter (stdlib only — ctypes, threading, urllib)
#  - libsrt1.5-openssl : libsrt loaded via ctypes
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        libsrt1.5-openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/ingest-media/src ./src

ENV PYTHONPATH=/app/src

# SRT (public) + SRTLA-internal inputs, and the SRT output OBS pulls from.
# All UDP. The output port is published only on the Tailscale interface in
# docker-compose; here we just document it.
EXPOSE 8888/udp 8889/udp 9000/udp

CMD ["python3", "-m", "ingest_media.main"]
