import { type Context } from "hono";
import { z } from "zod";
import { supabase } from "@repo/supabase";
import { endIngestSession } from "@repo/supabase/queries/ingest";
import { clearSessionStats } from "./session-stats";

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

  return c.json({ ok: true });
}
