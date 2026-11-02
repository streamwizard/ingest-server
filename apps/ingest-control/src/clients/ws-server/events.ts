// Live events from this node, sent on its ws-server socket. Fire-and-forget:
// if the socket is down the sample is skipped. InfluxDB and the session log
// stay the record; a dropped sample just means a viewer misses one reading.
//
// "Session ended" isn't sent from here: rest-api sends it itself when the node
// closes the session (POST /api/ingest-nodes/sessions/:id/end).
import type { IngestNodeStatsMessage, IngestNodeMetricsMessage } from "@repo/types";
import { wsServerClient } from "./client";

/**
 * One live quality sample for a session. ws-server turns it into
 * streamwizard.ingest_stats for the session's owner and adds node_id and the
 * stream key's id and label, so consumers can attribute the stream without a
 * DB lookup.
 */
export function broadcastSessionStats(
  sessionId: string,
  protocol: IngestNodeStatsMessage["protocol"],
  stats: Record<string, number>,
): void {
  wsServerClient.send({ kind: "ingest_stats", session_id: sessionId, protocol, stats, at: new Date().toISOString() });
}

/** This node's NIC throughput for ws-server's live ingest-node monitor. */
export function broadcastNodeBandwidth(sample: IngestNodeMetricsMessage["payload"]): void {
  wsServerClient.send({ kind: "node_metrics", payload: sample });
}
