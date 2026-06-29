import { type Context } from "hono";
import { z } from "zod";
import { supabase } from "@repo/supabase";
import { insertIngestSessionStatsBatch, type IngestSessionStatsInsert } from "@repo/supabase/queries/ingest";
import { trackIngestStreamSample } from "@repo/metrics";
import { wsBroadcastClient } from "../lib/ws-broadcast";

const bodySchema = z.object({
  session_id: z.string().uuid(),
  user_id: z.string().uuid(),
  protocol: z.enum(["rtmp", "srt", "srtla"]),
  stats: z.object({
    // Throughput (all protocols)
    kbps: z.number().optional(),
    // Rates / link estimate (SRT/SRTLA only)
    mbps_recv_rate: z.number().optional(),
    mbps_bandwidth: z.number().optional(),
    mbps_max_bw: z.number().optional(),
    rtt_ms: z.number().optional(),
    // Window counters (since last sample)
    pkt_recv: z.number().optional(),
    pkt_recv_loss: z.number().optional(),
    pkt_recv_drop: z.number().optional(),
    pkt_recv_retrans: z.number().optional(),
    pkt_recv_belated: z.number().optional(),
    pkt_recv_undecrypt: z.number().optional(),
    pkt_reorder_distance: z.number().optional(),
    // Receiver buffer health
    ms_rcv_buf: z.number().optional(),
    byte_rcv_buf: z.number().optional(),
    pkt_flight_size: z.number().optional(),
    // Session totals
    pkt_recv_loss_total: z.number().optional(),
    pkt_recv_drop_total: z.number().optional(),
    pkt_recv_undecrypt_total: z.number().optional(),
    byte_recv_total: z.number().optional(),
  }),
});

/**
 * Loss / drop / retransmit as a percentage of packets received this window.
 * These are what a scene-switcher actually thresholds on (a raw count is
 * meaningless without the bitrate it occurred at); we derive them once here so
 * every consumer — WS subscriber, InfluxDB, app — sees the same number.
 */
function deriveRates(stats: z.infer<typeof bodySchema>["stats"]): Record<string, number> {
  const recv = stats.pkt_recv ?? 0;
  const loss = stats.pkt_recv_loss ?? 0;
  const denom = recv + loss; // received + lost = packets that should have arrived
  if (denom <= 0) return {};
  const pct = (n: number) => Math.round(((n / denom) * 100 + Number.EPSILON) * 100) / 100;
  const derived: Record<string, number> = { loss_pct: pct(loss) };
  if (stats.pkt_recv_drop !== undefined) derived.drop_pct = pct(stats.pkt_recv_drop);
  if (stats.pkt_recv_retrans !== undefined) derived.retrans_pct = pct(stats.pkt_recv_retrans);
  return derived;
}

export interface SessionStatsEntry {
  user_id: string;
  protocol: string;
  stats: Record<string, number>;
  updated_at: string;
}

// "Current" snapshot per active session, for instant reads (e.g. a future
// scene-switcher polling "how is this stream doing right now"). Bounded by the
// number of concurrently active sessions — overwritten in place, never
// accumulates — and entries are removed at session-end.
const latestStats = new Map<string, SessionStatsEntry>();

// Durable history is batched, not written per-sample: every report lands here
// first, and a timer below bulk-inserts + clears this on a fixed interval.
// Deliberately dropped (not retried) on insert failure — a metrics pipeline
// that retries forever on a network blip is how this buffer becomes the next
// "store it in RAM" problem.
let pendingRows: IngestSessionStatsInsert[] = [];

const FLUSH_INTERVAL_MS = 30_000;

async function flushPendingStats(): Promise<void> {
  if (pendingRows.length === 0) return;
  const batch = pendingRows;
  pendingRows = [];
  const { error } = await insertIngestSessionStatsBatch(supabase, batch);
  if (error) {
    console.error(`[session-stats] failed to insert batch of ${batch.length}:`, error);
  }
}

export function startSessionStatsFlusher(): void {
  setInterval(() => {
    flushPendingStats().catch((err) => console.error("[session-stats] flush error:", err));
  }, FLUSH_INTERVAL_MS);
}

export function clearSessionStats(sessionId: string): void {
  latestStats.delete(sessionId);
}

/**
 * POST /internal/session-stats
 *
 * Called by the media plane every couple of seconds while a session is active,
 * reporting throughput (and, for SRT/SRTLA, loss/RTT/bandwidth) for that stream.
 */
export async function sessionStatsHandler(c: Context) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const updatedAt = new Date().toISOString();
  const fullStats = { ...body.stats, ...deriveRates(body.stats) };

  latestStats.set(body.session_id, {
    user_id: body.user_id,
    protocol: body.protocol,
    stats: fullStats,
    updated_at: updatedAt,
  });

  // Time-series: full sample (raw + derived) → InfluxDB. Per-stream timelines
  // and the cross-stream "global" view are both just queries over these points.
  trackIngestStreamSample(body.session_id, body.user_id, body.protocol, fullStats);

  // Durable record: only the columns that exist on ingest_session_stats. The
  // richer transport fields live in InfluxDB; this stays a stable session log.
  pendingRows.push({
    session_id: body.session_id,
    user_id: body.user_id,
    protocol: body.protocol,
    recorded_at: updatedAt,
    kbps: body.stats.kbps,
    mbps_recv_rate: body.stats.mbps_recv_rate,
    mbps_bandwidth: body.stats.mbps_bandwidth,
    rtt_ms: body.stats.rtt_ms,
    pkt_recv_loss: body.stats.pkt_recv_loss,
    pkt_recv_drop: body.stats.pkt_recv_drop,
    pkt_recv_retrans: body.stats.pkt_recv_retrans,
    pkt_recv_loss_total: body.stats.pkt_recv_loss_total,
    byte_recv_total: body.stats.byte_recv_total,
  });

  // Live push: full raw + derived set, so the streamer's app decides when to
  // switch scenes on whichever parameters it cares about.
  wsBroadcastClient.send({
    userId: body.user_id,
    type: "streamwizard.ingest_stats",
    payload: { session_id: body.session_id, protocol: body.protocol, ...fullStats },
  });

  return c.json({ ok: true });
}

/**
 * GET /internal/session-stats/:sessionId
 *
 * Latest known quality snapshot for an active session — served from memory,
 * not the database, so it reflects the most recent sample even before the
 * next batch flush.
 */
export async function getSessionStatsHandler(c: Context) {
  const sessionId = c.req.param("sessionId");
  const entry = sessionId ? latestStats.get(sessionId) : undefined;
  if (!entry) {
    return c.json({ error: "No stats for session" }, 404);
  }
  return c.json(entry);
}
