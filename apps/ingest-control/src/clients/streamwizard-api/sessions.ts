// ingest_sessions and ingest_session_stats rows, read and written through
// rest-api. rest-api knows which node is calling from NODE_API_KEY and only
// answers for sessions this node opened (404 otherwise), so none of these take
// a node id, and none of them name a user: rest-api reads the owner off the
// stream key or the session row.
import { StreamwizardApi, nullOnStatus, pathSegment } from "./client";

export type IngestProtocol = "rtmp" | "srt" | "srtla";

export interface OpenSessionRequest {
  protocol: IngestProtocol;
  stream_key: string;
  remote_ip?: string | null;
}

export interface OpenedSession {
  session_id: string;
  user_id: string;
  /** ingest_stream_keys.id: the durable "camera" identity across reconnects. */
  stream_key_id: string;
  /** The user's name for the key, e.g. "Camera 1". */
  label: string;
  /** Active output keys an OBS Media Source can present to pull this feed. Often one, can be none. */
  output_keys: string[];
}

/**
 * Validates the stream key and opens a session row for it. rest-api also bumps
 * the key's last_used_at. Returns null when the key is unknown or inactive
 * (403); any other failure throws.
 */
export async function openSession(body: OpenSessionRequest): Promise<OpenedSession | null> {
  return nullOnStatus(403, () => StreamwizardApi.post<OpenedSession>("/api/ingest-nodes/sessions", body));
}

/**
 * Closes the session row. rest-api tells the owner the session ended
 * (streamwizard.ingest_session_ended), so the node doesn't send that event
 * itself.
 */
export async function endSession(sessionId: string, lastBitrateKbps?: number): Promise<void> {
  await StreamwizardApi.post(`/api/ingest-nodes/sessions/${pathSegment(sessionId)}/end`, {
    last_bitrate_kbps: lastBitrateKbps ?? null,
  });
}

// The columns of ingest_session_stats the node fills in. user_id is not one of
// them: rest-api takes it from the session row.
export interface SessionStatsRow {
  session_id: string;
  protocol: IngestProtocol;
  recorded_at: string;
  kbps?: number | null;
  mbps_recv_rate?: number | null;
  mbps_bandwidth?: number | null;
  rtt_ms?: number | null;
  pkt_recv_loss?: number | null;
  pkt_recv_drop?: number | null;
  pkt_recv_retrans?: number | null;
  pkt_recv_loss_total?: number | null;
  byte_recv_total?: number | null;
}

/** Bulk-inserts a batch of buffered quality samples in one round trip. */
export async function insertSessionStats(rows: SessionStatsRow[]): Promise<void> {
  await StreamwizardApi.post("/api/ingest-nodes/session-stats", { rows });
}
