"""Tests for the A/V skew tracker.

Stdlib unittest, no fixtures on disk: each test builds its own MPEG-TS so the
suite runs anywhere with `python -m unittest discover apps/ingest-media/tests`.

The builder reproduces the mux behaviour measured on a real ffmpeg-produced
transport stream (10s, 30fps H.264, AAC): audio is aggregated into PES packets
covering ~320ms and each one is written ahead of the video frame carrying the
same timestamp, which is why an uncorrected newest-vs-newest comparison reads
~300ms of skew on a stream that is perfectly in sync. That number is the whole
reason the tracker subtracts the measured interval, so it is what these tests
pin down.
"""

from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ingest_media.av_sync import AvSyncTracker  # noqa: E402

VIDEO_PID = 0x100
AUDIO_PID = 0x101
VIDEO_STREAM_ID = 0xE0
AUDIO_STREAM_ID = 0xC0

TICKS_PER_MS = 90
FRAME_TICKS = 3000  # 30fps
AUDIO_PES_TICKS = 28_800  # 320ms, as measured on the reference stream
SRT_PAYLOAD = 1316  # 7 x 188, the usual SRT live message size


def _encode_pts(pts: int) -> bytes:
    return bytes(
        [
            0b0010_0001 | ((pts >> 29) & 0x0E),
            (pts >> 22) & 0xFF,
            ((pts >> 14) & 0xFE) | 1,
            (pts >> 7) & 0xFF,
            ((pts << 1) & 0xFE) | 1,
        ]
    )


def ts_packet(pid: int, stream_id: int, pts: int) -> bytes:
    """One 188-byte TS packet carrying the start of a PES with `pts`."""
    header = bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10])
    pes = bytes([0x00, 0x00, 0x01, stream_id, 0x00, 0x00, 0x80, 0x80, 0x05]) + _encode_pts(pts)
    return (header + pes).ljust(188, b"\xff")


def build_stream(seconds: int = 10, audio_shift_ticks: int = 0) -> bytes:
    """A muxed TS. `audio_shift_ticks` stamps audio on an offset clock, the way
    an encoder with a wrong audio time-base would, without moving the packets."""
    packets: list[bytes] = []
    next_audio_pts = 0
    for frame in range(seconds * 30):
        video_pts = frame * FRAME_TICKS
        # Audio PES for timestamp P is written ahead of the video carrying
        # P + one PES interval. This lead is the bias the tracker corrects.
        while next_audio_pts + AUDIO_PES_TICKS <= video_pts:
            packets.append(ts_packet(AUDIO_PID, AUDIO_STREAM_ID, next_audio_pts + audio_shift_ticks))
            next_audio_pts += AUDIO_PES_TICKS
        packets.append(ts_packet(VIDEO_PID, VIDEO_STREAM_ID, video_pts))
    return b"".join(packets)


def run(data: bytes, chunk: int = SRT_PAYLOAD) -> dict:
    tracker = AvSyncTracker()
    for i in range(0, len(data), chunk):
        tracker.feed(data[i : i + chunk])
    return tracker.sample()


class AvSyncTrackerTest(unittest.TestCase):
    def test_synced_stream_reads_near_zero(self):
        """The point of the interval correction: raw would read ~+320ms here."""
        s = run(build_stream())
        self.assertAlmostEqual(s["av_skew_ms"], 0, delta=40)
        self.assertGreater(s["av_skew_raw_ms"], 200, "raw gap should carry the mux bias")
        self.assertAlmostEqual(s["av_audio_pes_interval_ms"], 320, delta=5)

    def test_audio_stamped_late_reads_positive(self):
        """Positive = audio behind video, the failure mode this exists to catch."""
        s = run(build_stream(audio_shift_ticks=500 * TICKS_PER_MS))
        self.assertAlmostEqual(s["av_skew_ms"], 500, delta=40)

    def test_audio_stamped_early_reads_negative(self):
        s = run(build_stream(audio_shift_ticks=-300 * TICKS_PER_MS))
        self.assertAlmostEqual(s["av_skew_ms"], -300, delta=40)

    def test_offset_is_recovered_independently_of_the_bias(self):
        """Skew must move 1:1 with the injected offset, not merely correlate."""
        base = run(build_stream())["av_skew_ms"]
        for ms in (-500, -100, 250, 500, 900):
            s = run(build_stream(audio_shift_ticks=ms * TICKS_PER_MS))
            self.assertAlmostEqual(s["av_skew_ms"] - base, ms, delta=20, msg=f"offset {ms}ms")

    def test_video_only_stream_reports_nothing(self):
        """No audio means no skew to report — never a fake zero."""
        packets = [ts_packet(VIDEO_PID, VIDEO_STREAM_ID, f * FRAME_TICKS) for f in range(300)]
        self.assertEqual(run(b"".join(packets)), {})

    def test_survives_ragged_chunk_boundaries(self):
        """SRT should deliver whole TS packets; the tracker must not rely on it."""
        data = build_stream()
        tracker = AvSyncTracker()
        rng = random.Random(1)
        i = 0
        while i < len(data):
            n = rng.choice([SRT_PAYLOAD, SRT_PAYLOAD, 700, 188, 1500])
            tracker.feed(data[i : i + n])
            i += n
        self.assertAlmostEqual(tracker.sample()["av_skew_ms"], 0, delta=40)

    def test_garbage_never_raises_or_disables(self):
        """This runs in the relay's read loop; a metric must not kill a stream."""
        tracker = AvSyncTracker()
        rng = random.Random(2)
        for _ in range(50):
            tracker.feed(bytes(rng.getrandbits(8) for _ in range(SRT_PAYLOAD)))
        self.assertTrue(tracker._enabled)
        self.assertEqual(tracker.sample(), {})

    def test_pts_wrap_does_not_produce_a_huge_skew(self):
        """PTS is 33-bit and wraps every ~26.5h; a wrap mid-window must not
        register as hours of skew."""
        modulo = 1 << 33
        start = modulo - 5 * 90_000  # wrap five seconds in
        packets: list[bytes] = []
        next_audio = start
        for frame in range(300):
            video_pts = (start + frame * FRAME_TICKS) % modulo
            while (next_audio + AUDIO_PES_TICKS - start) % modulo <= (video_pts - start) % modulo:
                packets.append(ts_packet(AUDIO_PID, AUDIO_STREAM_ID, next_audio % modulo))
                next_audio += AUDIO_PES_TICKS
            packets.append(ts_packet(VIDEO_PID, VIDEO_STREAM_ID, video_pts))
        self.assertAlmostEqual(run(b"".join(packets))["av_skew_ms"], 0, delta=40)

    def test_sample_resets_its_window(self):
        run_data = build_stream(seconds=2)
        tracker = AvSyncTracker()
        for i in range(0, len(run_data), SRT_PAYLOAD):
            tracker.feed(run_data[i : i + SRT_PAYLOAD])
        self.assertTrue(tracker.sample())
        self.assertEqual(tracker.sample(), {})


if __name__ == "__main__":
    unittest.main()
