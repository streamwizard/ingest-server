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

# Two real muxes, an order of magnitude apart in how they packetise audio:
#   ffmpeg aggregates ~15 AAC frames per PES  -> ~320ms
#   a phone encoder seen on staging sends one -> ~23ms (1024 samples @ 48kHz)
# The correction subtracts whichever interval the stream is actually using, so
# both have to work.
AUDIO_PES_TICKS = 28_800  # 320ms, ffmpeg reference stream
AUDIO_PES_TICKS_SMALL = 2_090  # ~23ms, one AAC frame per PES

SRT_PAYLOAD = 1316  # 7 x 188, the usual SRT live message size

# Skew is sampled at each audio PES against the newest video PTS, which by
# then is up to one frame stale — so a perfectly synced stream reads half a
# frame high. Independent of how the audio is packetised: it shows up as the
# same +16.7ms on both the 320ms and the 23ms mux.
HALF_FRAME_MS = FRAME_TICKS / TICKS_PER_MS / 2


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


def build_stream(
    seconds: int = 10,
    audio_shift_ticks: int = 0,
    audio_pes_ticks: int = AUDIO_PES_TICKS,
    mux_lead_ticks: int | None = None,
) -> bytes:
    """A muxed TS.

    `audio_shift_ticks` stamps audio on an offset clock, the way an encoder
    with a wrong audio time-base would, without moving the packets.

    `mux_lead_ticks` is how far ahead of its matching video the muxer writes
    each audio PES. It defaults to one PES interval, which is what the tracker
    assumes and what the ffmpeg reference stream does (318.6ms interval,
    316.1ms measured lead). Passing something else models a muxer that does
    not, which is how the bound on the correction's error gets tested.
    """
    lead = audio_pes_ticks if mux_lead_ticks is None else mux_lead_ticks
    packets: list[bytes] = []
    next_audio_pts = 0
    for frame in range(seconds * 30):
        video_pts = frame * FRAME_TICKS
        while next_audio_pts + lead <= video_pts:
            packets.append(ts_packet(AUDIO_PID, AUDIO_STREAM_ID, next_audio_pts + audio_shift_ticks))
            next_audio_pts += audio_pes_ticks
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

    def test_small_audio_pes_mux(self):
        """One AAC frame per PES (~23ms), as a phone encoder on staging sends.
        An order of magnitude off the ffmpeg reference the correction was
        derived from, so the interval must be measured, never assumed."""
        s = run(build_stream(audio_pes_ticks=AUDIO_PES_TICKS_SMALL))
        self.assertAlmostEqual(s["av_skew_ms"], HALF_FRAME_MS, delta=10)
        self.assertAlmostEqual(s["av_audio_pes_interval_ms"], 23, delta=3)

    def test_small_audio_pes_mux_recovers_offset(self):
        s = run(build_stream(audio_shift_ticks=500 * TICKS_PER_MS,
                             audio_pes_ticks=AUDIO_PES_TICKS_SMALL))
        self.assertAlmostEqual(s["av_skew_ms"], 500 + HALF_FRAME_MS, delta=10)

    def test_offset_recovery_does_not_depend_on_pes_interval(self):
        """The property that matters: whatever the mux does, an injected
        offset must still come back 1:1."""
        for interval in (AUDIO_PES_TICKS_SMALL, 9_000, AUDIO_PES_TICKS):
            base = run(build_stream(audio_pes_ticks=interval))["av_skew_ms"]
            for ms in (-400, 500):
                s = run(build_stream(audio_shift_ticks=ms * TICKS_PER_MS, audio_pes_ticks=interval))
                self.assertAlmostEqual(
                    s["av_skew_ms"] - base, ms, delta=20,
                    msg=f"interval {interval / 90:.0f}ms, offset {ms}ms",
                )

    def test_correction_error_is_bounded_by_the_pes_interval(self):
        """The known limitation, pinned rather than papered over.

        The correction assumes the muxer writes each audio PES one interval
        ahead of its video. A muxer that leads by some other amount reads off
        by (interval - lead), so the worst case is bounded by the interval
        itself. That is why a 23ms-PES stream is trustworthy to a few tens of
        ms no matter what its muxer does, while a 320ms-PES stream leans on
        the assumption holding.
        """
        for interval in (AUDIO_PES_TICKS_SMALL, AUDIO_PES_TICKS):
            for lead in (0, interval // 2, interval):
                skew = run(build_stream(audio_pes_ticks=interval, mux_lead_ticks=lead))["av_skew_ms"]
                self.assertLessEqual(
                    abs(skew), interval / 90 + 20,
                    msg=f"interval {interval / 90:.0f}ms, lead {lead / 90:.0f}ms read {skew}ms",
                )

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
