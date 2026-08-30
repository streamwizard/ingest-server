"""A/V sync measurement on the passthrough relay.

The relay forwards MPEG-TS verbatim, so the bytes going past it are exactly
what the streamer's phone muxed. Reading the PES presentation timestamps out
of that stream tells us whether audio and video were already skewed when they
arrived — which is the question you cannot answer from OBS's side, where a
skew that came in with the feed and a skew OBS introduced look identical.

What it measures: at each audio PES, the gap between the newest video PTS and
that audio PTS, reduced to a median per window. That raw gap is NOT the skew.
A muxer aggregates audio into PES packets covering a few hundred milliseconds
and writes each one ahead of the video carrying the same timestamp, so a
perfectly synced stream reads a large positive raw gap. Measured on a
reference file built by ffmpeg (10s, 30fps video, AAC audio, no offset): audio
PES interval 318.6ms, raw gap 304.0ms — the bias is one audio PES interval,
to within 5%.

So the reported skew subtracts the interval this stream is actually using,
which the tracker measures from consecutive audio PTS rather than assuming:

    av_skew_ms = mean_audio_pes_interval - median(video_pts - audio_pts)

`av_skew_raw_ms` and `av_audio_pes_interval_ms` are reported alongside so the
correction is auditable rather than a magic number, and min/max bound the
spread.

Two known biases, both small and both pinned by the tests:

- A synced stream reads about half a video frame high (+16.7ms at 30fps),
  because the newest video PTS is up to one frame stale at the moment an
  audio PES is sampled. Independent of how audio is packetised.
- The correction assumes a muxer writes each audio PES one interval ahead of
  its matching video. One that leads by some other amount reads off by
  (interval - lead), so the error is bounded by the interval. A stream
  sending one AAC frame per PES (~23ms, seen from a phone encoder on
  staging) is therefore trustworthy to a few tens of ms whatever its muxer
  does; a stream aggregating ~15 frames (~320ms, ffmpeg's default) leans on
  the assumption holding.

Either way the figure is good to a few tens of milliseconds, which is what a
lip-sync problem worth chasing has to clear anyway.

Sign convention: positive `av_skew_ms` means audio is BEHIND video.

What this can and cannot see: it compares the two streams' TIMESTAMPS. An
encoder that stamps audio with an offset clock shows up here. An encoder that
stamps both correctly but captured the audio late — a buffer delay in the
phone's capture path — produces a stream whose timestamps are self-consistent
and reads zero here, while still sounding out of sync. A zero narrows the
search, it does not clear the sender.

This runs inside the relay's read loop, so it is written to never raise and
never block: `feed()` swallows everything and disables the tracker after
repeated failures rather than risk taking a live stream down for a metric.
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

TS_PACKET_SIZE = 188
TS_SYNC_BYTE = 0x47

# PTS/DTS are 33-bit values on a 90 kHz clock.
PTS_CLOCK_HZ = 90_000
PTS_MODULO = 1 << 33
PTS_HALF = PTS_MODULO >> 1

# PES stream_id ranges (ISO/IEC 13818-1 table 2-18). Reading the stream_id off
# the PES header identifies audio vs video without tracking PAT/PMT state,
# which keeps this to a single stateless pass over the packet.
_VIDEO_STREAM_ID_MIN, _VIDEO_STREAM_ID_MAX = 0xE0, 0xEF
_AUDIO_STREAM_ID_MIN, _AUDIO_STREAM_ID_MAX = 0xC0, 0xDF

# Give up after this many consecutive exceptions rather than log on every
# chunk for the rest of the session.
_MAX_ERRORS = 10


def _decode_pts(buf: bytes, offset: int) -> Optional[int]:
    """Decode the 5-byte 33-bit PTS field at `offset`, or None if truncated."""
    if offset + 5 > len(buf):
        return None
    b0, b1, b2, b3, b4 = buf[offset : offset + 5]
    return (
        ((b0 & 0x0E) << 29)
        | (b1 << 22)
        | ((b2 & 0xFE) << 14)
        | (b3 << 7)
        | ((b4 & 0xFE) >> 1)
    )


def _pts_delta(a: int, b: int) -> int:
    """a - b on the 33-bit PTS clock, taking the shorter way around the wrap."""
    diff = (a - b) % PTS_MODULO
    return diff - PTS_MODULO if diff > PTS_HALF else diff


class AvSyncTracker:
    """Accumulates PTS skew samples; `sample()` drains them into stat fields."""

    def __init__(self) -> None:
        self._last_video_pts: Optional[int] = None
        self._last_audio_pts: Optional[int] = None
        self._skews: list[int] = []
        self._audio_gaps: list[int] = []
        self._video_pes = 0
        self._audio_pes = 0
        self._errors = 0
        self._enabled = True

    def feed(self, chunk: bytes) -> None:
        """Scan one SRT payload for PES headers. Never raises."""
        if not self._enabled:
            return
        try:
            self._scan(chunk)
            self._errors = 0
        except Exception:  # noqa: BLE001 - a metric must never kill the relay
            self._errors += 1
            if self._errors >= _MAX_ERRORS:
                self._enabled = False
                log.exception("av sync tracker disabled after %d consecutive errors", _MAX_ERRORS)

    def _scan(self, chunk: bytes) -> None:
        # SRT live messages carry whole TS packets (the usual payload size,
        # 1316 bytes, is 7 x 188), but align defensively rather than assume it.
        start = 0
        if not chunk or chunk[0] != TS_SYNC_BYTE:
            start = chunk.find(bytes([TS_SYNC_BYTE]))
            if start < 0:
                return

        for base in range(start, len(chunk) - TS_PACKET_SIZE + 1, TS_PACKET_SIZE):
            if chunk[base] != TS_SYNC_BYTE:
                return  # lost alignment; the next chunk re-syncs from its own start
            self._scan_packet(chunk, base)

    def _scan_packet(self, chunk: bytes, base: int) -> None:
        b1 = chunk[base + 1]
        if b1 & 0x80:  # transport_error_indicator - contents are unreliable
            return
        if not b1 & 0x40:  # payload_unit_start_indicator: no PES header here
            return

        b3 = chunk[base + 3]
        if b3 & 0xC0:  # transport_scrambling_control: payload is not readable
            return

        adaptation = (b3 & 0x30) >> 4
        if adaptation in (0, 2):  # no payload (reserved, or adaptation only)
            return

        payload = base + 4
        if adaptation == 3:  # adaptation field, then payload
            payload += 1 + chunk[base + 4]

        end = base + TS_PACKET_SIZE
        if payload + 14 > end:  # not enough room for a PES header with a PTS
            return

        # PES start code prefix 0x000001, then stream_id.
        if chunk[payload] != 0x00 or chunk[payload + 1] != 0x00 or chunk[payload + 2] != 0x01:
            return
        stream_id = chunk[payload + 3]

        if _VIDEO_STREAM_ID_MIN <= stream_id <= _VIDEO_STREAM_ID_MAX:
            is_video = True
        elif _AUDIO_STREAM_ID_MIN <= stream_id <= _AUDIO_STREAM_ID_MAX:
            is_video = False
        else:
            return  # padding, private streams, etc.

        # PES_header flags: PTS_DTS_flags live in the top two bits of byte 7.
        # 0b10 = PTS only, 0b11 = PTS then DTS; either way PTS starts at +9.
        if not chunk[payload + 7] & 0x80:
            return
        pts = _decode_pts(chunk, payload + 9)
        if pts is None:
            return

        if is_video:
            self._last_video_pts = pts
            self._video_pes += 1
            return

        # Sample only at audio PES: audio is the sparse stream, so the newest
        # video PTS is at most one frame stale here, whereas sampling at video
        # PES would compare against audio up to a full PES interval old.
        if self._last_audio_pts is not None:
            self._audio_gaps.append(_pts_delta(pts, self._last_audio_pts))
        self._last_audio_pts = pts
        self._audio_pes += 1

        if self._last_video_pts is not None:
            self._skews.append(_pts_delta(self._last_video_pts, pts))

    def sample(self) -> dict:
        """Stats for the window since the last call; resets the window.

        Returns {} when nothing usable was parsed, so a stream this cannot read
        (an unexpected container, or a scrambled payload) simply reports no
        A/V fields rather than a misleading zero.
        """
        skews, gaps = self._skews, self._audio_gaps
        self._skews, self._audio_gaps = [], []
        video_pes, audio_pes = self._video_pes, self._audio_pes
        self._video_pes = self._audio_pes = 0

        # Both halves are required: without the interval there is nothing to
        # correct the mux bias with, and an uncorrected figure reads as ~300ms
        # of skew on a stream that is perfectly in sync.
        if not skews or not gaps:
            return {}

        skews.sort()
        gaps.sort()
        to_ms = 1000.0 / PTS_CLOCK_HZ
        raw_ms = skews[len(skews) // 2] * to_ms
        interval_ms = gaps[len(gaps) // 2] * to_ms
        return {
            "av_skew_ms": round(interval_ms - raw_ms, 1),
            "av_skew_raw_ms": round(raw_ms, 1),
            "av_audio_pes_interval_ms": round(interval_ms, 1),
            "av_skew_raw_ms_min": round(skews[0] * to_ms, 1),
            "av_skew_raw_ms_max": round(skews[-1] * to_ms, 1),
            "av_skew_samples": len(skews),
            "video_pes_count": video_pes,
            "audio_pes_count": audio_pes,
        }
