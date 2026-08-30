"""Environment configuration for the ingest media plane."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    # Control plane (Bun) — validates stream keys and provisions OBS.
    control_url: str
    control_secret: str

    # Public SRT ingest port (streamers connect here directly).
    srt_port: int
    # Internal SRT port fed by the Belabox srtla_receiver; connections here are
    # tagged with the "srtla" protocol but are otherwise plain SRT.
    srtla_srt_port: int
    # SRT output port OBS pulls from (one listener; routed by output-key
    # streamid). Published only on the Tailscale interface — see docker-compose.
    output_port: int

    # SRT receiver-buffer latency (ms) for the ingress listeners (srt/srtla —
    # the streamer's phone connects here over cellular). A few seconds of
    # retransmit budget; the libsrt default of 120ms is too low for IRL.
    srt_ingress_latency_ms: int
    # SRT receiver-buffer latency (ms) for the output listener OBS pulls from.
    # That hop is server-to-server over the tailnet (RTT <30ms), so a few
    # hundred ms is plenty — matching the ingress 4s here just added dead
    # glass-to-glass delay. SRT negotiates max(sender, receiver): keep in sync
    # with the OBS Media Source `latency=` query param (obs-irl.ts).
    srt_egress_latency_ms: int

    # Parse PES timestamps off the relayed MPEG-TS to report the audio/video
    # skew the streamer's encoder actually sent (see av_sync.py). Costs one
    # header read per TS packet, off the forwarding path; kill switch for a
    # node where that is not wanted.
    av_sync_enabled: bool

    # How long (seconds) to wait for the control plane before rejecting a connect.
    control_timeout: float

    log_level: str


def load_config() -> Config:
    control_url = os.environ.get("INGEST_CONTROL_URL")
    control_secret = os.environ.get("INGEST_CONTROL_SECRET")
    if not control_url:
        raise RuntimeError("INGEST_CONTROL_URL is required")
    if not control_secret:
        raise RuntimeError("INGEST_CONTROL_SECRET is required")

    return Config(
        control_url=control_url.rstrip("/"),
        control_secret=control_secret,
        srt_port=int(os.environ.get("INGEST_SRT_PORT", "8888")),
        srtla_srt_port=int(os.environ.get("INGEST_SRTLA_SRT_PORT", "8889")),
        output_port=int(os.environ.get("INGEST_OUTPUT_PORT", "9000")),
        # INGEST_SRT_LATENCY_MS is the legacy single-knob name; it keeps
        # working as the ingress fallback for nodes installed before the split.
        srt_ingress_latency_ms=int(
            os.environ.get("INGEST_SRT_INGRESS_LATENCY_MS")
            or os.environ.get("INGEST_SRT_LATENCY_MS", "4000")
        ),
        srt_egress_latency_ms=int(os.environ.get("INGEST_SRT_EGRESS_LATENCY_MS", "300")),
        av_sync_enabled=os.environ.get("INGEST_AV_SYNC_ENABLED", "true").lower() not in ("0", "false", "no"),
        control_timeout=float(os.environ.get("INGEST_CONTROL_TIMEOUT", "5")),
        log_level=os.environ.get("INGEST_LOG_LEVEL", "INFO"),
    )
