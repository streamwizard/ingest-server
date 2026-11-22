# Belabox SRTLA receiver (srtla_rec).
#
# srtla_rec terminates bonded SRTLA links and forwards the reconstructed SRT
# stream (streamid intact) to the ingest media plane's internal SRT listener.
# It is transparent to SRT, so the streamer's stream key in the SRT streamid
# flows straight through to our authorization logic.
#
# Usage: srtla_rec <SRTLA_LISTEN_PORT> <SRT_HOST> <SRT_PORT>

FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Pinned, so every node runs a known version (BELABOX srtla is AGPL-3.0: we
# must be able to name and offer the exact source we run). 37862da is upstream
# main of 2025-04-05, the version the local image was built and measured with.
ARG SRTLA_COMMIT=37862da3d0c13b46956efd3f88877053293d97d6
RUN git init -q . \
    && git remote add origin https://github.com/BELABOX/srtla.git \
    && git fetch -q --depth 1 origin "$SRTLA_COMMIT" \
    && git checkout -q FETCH_HEAD \
    && make

FROM debian:bookworm-slim AS runner
COPY --from=build /src/srtla_rec /usr/local/bin/srtla_rec
EXPOSE 5000/udp
ENTRYPOINT ["srtla_rec"]
# Overridden by docker-compose command; forwards to the media plane by default.
CMD ["5000", "ingest-media", "8889"]
