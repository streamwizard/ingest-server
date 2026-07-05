import { Point } from "@influxdata/influxdb-client";
import { pushPoint } from "./influx-client";

// Per-stream ingest quality samples. One point per sample (~1/s) per active
// session, tagged so the app can both read a single stream's timeline and
// aggregate across all active streams (count, total bandwidth, loss spread) —
// the "global metrics" view is just a query over these points, no separate
// aggregate endpoint needed.
//
// Fields are written conditionally — an absent metric is simply not a field on
// that point, never a zero that would skew averages.

export interface IngestStreamSample {
  kbps?: number;
  mbps_recv_rate?: number;
  mbps_bandwidth?: number;
  mbps_max_bw?: number;
  rtt_ms?: number;
  pkt_recv?: number;
  pkt_recv_loss?: number;
  pkt_recv_drop?: number;
  pkt_recv_retrans?: number;
  pkt_recv_belated?: number;
  pkt_recv_undecrypt?: number;
  pkt_reorder_distance?: number;
  ms_rcv_buf?: number;
  byte_rcv_buf?: number;
  pkt_flight_size?: number;
  pkt_recv_loss_total?: number;
  pkt_recv_drop_total?: number;
  pkt_recv_undecrypt_total?: number;
  byte_recv_total?: number;
  // Derived percentages over the sample window (computed in the control plane).
  loss_pct?: number;
  drop_pct?: number;
  retrans_pct?: number;
}

export interface IngestStreamKeyInfo {
  streamKeyId: string;
  label: string;
}

export function trackIngestStreamSample(
  sessionId: string,
  userId: string,
  protocol: string,
  sample: IngestStreamSample,
  streamKey?: IngestStreamKeyInfo,
): void {
  const point = new Point("ingest_stream")
    .tag("session_id", sessionId)
    .tag("user_id", userId)
    .tag("protocol", protocol);

  // stream_key_id is the durable identity of a user's incoming signal (e.g.
  // one of several cameras) across reconnects — session_id alone only
  // identifies the current connection. label is a mutable display name, so it
  // goes in as a field rather than a tag (tags should stay stable/low-cardinality).
  if (streamKey) {
    point.tag("stream_key_id", streamKey.streamKeyId);
    point.stringField("label", streamKey.label);
  }

  for (const [key, value] of Object.entries(sample)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      point.floatField(key, value);
    }
  }

  pushPoint(point);
}
