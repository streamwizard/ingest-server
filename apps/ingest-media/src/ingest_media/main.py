"""Entrypoint for the ingest media plane.

Pure libsrt: a shared output listener (OBS pulls, routed by output-key streamid)
plus the SRT (public) and SRTLA (internal, fed by srtla_receiver) input
listeners. No GStreamer/GLib — input MPEG-TS is relayed verbatim to OBS.
"""

from __future__ import annotations

import logging
import signal
import threading

from . import libsrt
from .config import load_config
from .control_client import ControlClient
from .output_router import OutputRouter
from .srt_listener import SrtListener


def main() -> None:
    config = load_config()
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("ingest-media")

    libsrt.startup()
    control = ControlClient(config)

    router = OutputRouter(config.output_port, latency_ms=config.srt_latency_ms)
    router.start()

    srt = SrtListener(config.srt_port, "srt", control, router, latency_ms=config.srt_latency_ms)
    srtla = SrtListener(config.srtla_srt_port, "srtla", control, router, latency_ms=config.srt_latency_ms)
    srt.start()
    srtla.start()

    stop = threading.Event()

    def shutdown(*_args) -> None:
        log.info("shutting down")
        srt.stop()
        srtla.stop()
        router.stop()
        libsrt.cleanup()
        stop.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log.info("ingest media plane started")
    stop.wait()


if __name__ == "__main__":
    main()
