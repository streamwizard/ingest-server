import { type Context } from "hono";
import { z } from "zod";
import { endSession } from "../clients/streamwizard-api/sessions";
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
 * through rest-api and drops the cached live stats. (The media plane owns the
 * output channel and tears it down on its side.)
 *
 * rest-api pushes streamwizard.ingest_session_ended to the owner when it closes
 * the row, so the auto-switcher reacts to a clean disconnect instantly instead
 * of waiting out its stats-silence timeout. If that call fails, the timeout
 * path still covers it.
 */
export async function sessionEndHandler(c: Context) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  try {
    await endSession(body.session_id, body.last_bitrate_kbps);
  } catch (err) {
    console.error(`[session-end] failed to close session ${body.session_id}:`, (err as Error).message);
  }
  clearSessionStats(body.session_id);

  return c.json({ ok: true });
}
