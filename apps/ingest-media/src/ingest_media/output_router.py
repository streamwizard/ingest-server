"""Streamid-routed SRT output.

One libsrt listener serves every OBS consumer. An OBS Media Source connects as
an SRT caller and presents an *output key* as its streamid; the router matches
that key to the live stream's OutputChannel and attaches the socket. The relay
then fans every received chunk into the channel, which writes it to each
attached OBS socket.

This mirrors the input side (one listener, route by streamid) — the only
difference is direction. OBS connect/disconnect is fully decoupled from the
streamer's session: an OBS that drops and reconnects just re-attaches; the
ingest session is untouched.
"""

from __future__ import annotations

import logging
import threading
from typing import Dict, Optional

from . import libsrt

log = logging.getLogger(__name__)


class OutputChannel:
    """The output side of one ingest session: the set of OBS sockets pulling it.

    Created when a stream is authorized, registered under its output key(s), and
    closed at session-end. `send()` is called from the relay's read loop for
    every chunk; sockets that error out are dropped so one dead OBS can't stall
    the others or the relay.
    """

    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self._socks: set[int] = set()
        self._lock = threading.Lock()
        self._closed = False

    def attach(self, sock: int) -> None:
        with self._lock:
            if self._closed:
                libsrt.close(sock)
                return
            self._socks.add(sock)
        log.info("output: OBS attached to session %s (%d consumer(s))", self._session_id, len(self._socks))

    def send(self, data: bytes) -> None:
        with self._lock:
            if not self._socks:
                return
            dead = [s for s in self._socks if not libsrt.send(s, data)]
            for s in dead:
                self._socks.discard(s)
        for s in dead:
            libsrt.close(s)
            log.info("output: OBS consumer dropped from session %s", self._session_id)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            socks = list(self._socks)
            self._socks.clear()
        for s in socks:
            libsrt.close(s)


class OutputRouter:
    def __init__(self, port: int, latency_ms: int = 0) -> None:
        self._port = port
        self._latency_ms = latency_ms
        self._listen_sock: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._routes: Dict[str, OutputChannel] = {}
        self._lock = threading.Lock()

    def start(self) -> None:
        self._listen_sock = libsrt.create_listener(self._port, latency_ms=self._latency_ms)
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, name="output-listen", daemon=True)
        self._thread.start()
        log.info("output listener bound on :%d", self._port)

    def register(self, keys: tuple[str, ...], channel: OutputChannel) -> None:
        if not keys:
            return
        with self._lock:
            for key in keys:
                self._routes[key] = channel

    def unregister(self, keys: tuple[str, ...]) -> None:
        with self._lock:
            for key in keys:
                self._routes.pop(key, None)

    def _accept_loop(self) -> None:
        assert self._listen_sock is not None
        while self._running:
            try:
                conn, peer_ip = libsrt.accept(self._listen_sock)
            except RuntimeError as exc:
                if self._running:
                    log.error("output accept failed: %s", exc)
                continue
            output_key = libsrt.parse_stream_key(libsrt.get_streamid(conn))
            if not output_key:
                log.warning("output: rejected OBS from %s (no streamid — set the output key as SRT stream ID in OBS)", peer_ip)
                libsrt.close(conn)
                continue
            with self._lock:
                channel = self._routes.get(output_key)
                active_keys = list(self._routes.keys())
            if channel is None:
                log.warning(
                    "output: rejected OBS from %s (output key %s*** not found — active keys: %s)",
                    peer_ip,
                    output_key[:6],
                    [k[:6] + "***" for k in active_keys] if active_keys else "none (no live stream)",
                )
                libsrt.close(conn)
                continue
            channel.attach(conn)

    def stop(self) -> None:
        self._running = False
        if self._listen_sock is not None:
            libsrt.close(self._listen_sock)
