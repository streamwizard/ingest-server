import { type Context } from "hono";
import { z } from "zod";
import { supabase } from "@repo/supabase";
import { endIngestSession } from "@repo/supabase/queries/ingest";
import { clearSessionStats } from "./session-stats";
import { wsBroadcastClient } from "../lib/ws-broadcast";
import { env } from "../lib/env";

const bodySchema = z.object({
  session_id: z.string().uuid(),
  user_id: z.string().uuid(),
  last_bitrate_kbps: z.number().int().optional(),
});

/**
 * POST /internal/session-end
 *
 * Called by the media plane when a streamer disconnects. Closes the session row
 * and drops the cached live stats. (The media plane owns the output channel and
 * tears it down on its side.)
 */
export async function sessionEndHandler(c: Context) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { error } = await endIngestSession(supabase, body.session_id, body.last_bitrate_kbps);
  if (error) {
    console.error(`[session-end] failed to close session ${body.session_id}:`, error);
  }
  clearSessionStats(body.session_id);

  // Live push so the auto-switcher reacts to a clean disconnect instantly
  // instead of waiting out its stats-silence timeout. Best-effort: if the
  // ws-server link is down, the timeout path still covers it.
  wsBroadcastClient.send({
    userId: body.user_id,
    type: "streamwizard.ingest_session_ended",
    payload: { session_id: body.session_id, node_id: env.INGEST_NODE_ID },
  });

  return c.json({ ok: true });
}
