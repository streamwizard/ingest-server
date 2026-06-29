"""SRT/SRTLA passthrough relay.

Pure libsrt: read MPEG-TS messages from the accepted input socket and hand each
one to the session's OutputChannel, which forwards it to whichever OBS consumers
are attached. No transcode, no remux, no GStreamer — the input is already
MPEG-TS and so is the output, so this is a verbatim copy plus the periodic
quality sample.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from . import libsrt
from .output_router import OutputChannel
from .stream_stats import BitrateTracker

log = logging.getLogger(__name__)

# How often (seconds) to sample throughput/quality and hand it to on_stats.
_STATS_INTERVAL = 1.0

# One SRT live message is at most ~1456 bytes; 1500 covers it with margin.
_RECV_SIZE = 1500


class SrtRelay:
    def __init__(
        self,
        conn_sock: int,
        channel: OutputChannel,
        on_end: Callable[[Optional[int]], None],
        on_stats: Optional[Callable[[dict], None]] = None,
    ) -> None:
        self._conn = conn_sock
        self._channel = channel
        self._on_end = on_end
        self._on_stats = on_stats
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.tracker = BitrateTracker()
        self._stats_timer: Optional[threading.Timer] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._feed, name="srt-relay", daemon=True)
        self._thread.start()
        if self._on_stats is not None:
            self._schedule_stats()

    def _schedule_stats(self) -> None:
        self._stats_timer = threading.Timer(_STATS_INTERVAL, self._report_stats)
        self._stats_timer.daemon = True
        self._stats_timer.start()

    def _report_stats(self) -> None:
        if self._on_stats is None:
            return
        stats = {"kbps": round(self.tracker.sample_kbps())}
        srt_stats = libsrt.get_stats(self._conn)
        if srt_stats is not None:
            stats.update(srt_stats)
        try:
            self._on_stats(stats)
        except Exception:  # noqa: BLE001
            log.exception("on_stats callback failed")
        if not self._stop.is_set():
            self._schedule_stats()

    def _feed(self) -> None:
        try:
            while not self._stop.is_set():
                chunk = libsrt.recv(self._conn, _RECV_SIZE)
                if not chunk:
                    break
                self.tracker.add_bytes(len(chunk))
                self._channel.send(chunk)
        except Exception:  # noqa: BLE001
            log.exception("srt relay feed error")
        finally:
            self._teardown()
            self._on_end(round(self.tracker.average_kbps()))

    def _teardown(self) -> None:
        self._stop.set()
        if self._stats_timer is not None:
            self._stats_timer.cancel()
        self._channel.close()
        libsrt.close(self._conn)

    def stop(self) -> None:
        self._stop.set()
