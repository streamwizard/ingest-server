// Live events from this node. rest-api checks a session is on this node, looks
// up its owner and forwards the event to that user's ws-server room. The node
// holds no ws-server credential: that secret works for every user, so it stays
// on rest-api.
//
// "Session ended" isn't sent from here: rest-api sends it itself when the node
// closes the session (POST /api/ingest-nodes/sessions/:id/end).
import { StreamwizardApi, pathSegment } from "./client";

type SessionEvent = {
  type: "stats";
  protocol: string;
  /** Raw transport counters plus the derived loss/drop/retrans percentages. */
  stats: Record<string, number>;
  at: string;
};

export interface NodeBandwidthSample {
  ts: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
  tailscale_rx_bytes_per_sec: number;
  tailscale_tx_bytes_per_sec: number;
}

// Fire-and-forget: never awaited and never throws into a caller. A failed push
// must not fail or slow a stats report from the media plane. InfluxDB and the
// session log stay the record; a dropped event just means a viewer misses one
// sample. Failures aren't logged per request either: the client logs when
// rest-api becomes unreachable and again when it recovers.
function post(path: () => string, body: unknown): void {
  try {
    StreamwizardApi.post(path(), body).catch(() => {});
  } catch {
    // pathSegment refused the id; there is no route to send it to.
  }
}

/**
 * One live quality sample for a session (streamwizard.ingest_stats). rest-api
 * adds node_id and the stream key's id and label, so consumers can attribute
 * the stream without a DB lookup.
 */
export function broadcastSessionStats(sessionId: string, protocol: string, stats: Record<string, number>): void {
  const event: SessionEvent = { type: "stats", protocol, stats, at: new Date().toISOString() };
  post(() => `/api/ingest-nodes/sessions/${pathSegment(sessionId)}/events`, event);
}

/** This node's NIC throughput for ws-server's live ingest-node monitor. */
export function broadcastNodeBandwidth(sample: NodeBandwidthSample): void {
  post(() => "/api/ingest-nodes/me/metrics", sample);
}
