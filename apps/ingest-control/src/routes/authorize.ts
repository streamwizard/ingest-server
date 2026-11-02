import { type Context } from "hono";
import { z } from "zod";
import { openSession, type OpenedSession } from "../clients/streamwizard-api/sessions";
import { registerSessionKey } from "./session-stats";

const bodySchema = z.object({
  protocol: z.enum(["rtmp", "srt", "srtla"]),
  stream_key: z.string().min(1),
  remote_ip: z.string().optional(),
});

/**
 * POST /internal/authorize
 *
 * Called by the media plane the moment a streamer connects. rest-api validates
 * the stream key and opens an ingest session; this returns the output key(s) under
 * which the media plane should register this session's output channel — an OBS
 * Media Source presents one of these as its SRT streamid to pull the feed from
 * the shared output listener.
 *
 * A stream with no configured output keys is still accepted (ingest + metrics
 * flow); it simply can't be pulled into OBS until a key exists.
 *
 * Responses:
 * - 200: { user_id, session_id, output_keys }
 * - 400: { error } (bad body)
 * - 403: { error } (unknown / inactive key)
 * - 500: { error }
 */
export async function authorizeHandler(c: Context) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  let session: OpenedSession | null;
  try {
    session = await openSession({
      protocol: body.protocol,
      stream_key: body.stream_key,
      remote_ip: body.remote_ip ?? null,
    });
  } catch (err) {
    console.error("[authorize] failed to open session:", (err as Error).message);
    return c.json({ error: "Failed to open session" }, 500);
  }

  if (!session) {
    return c.json({ error: "Invalid stream key" }, 403);
  }

  registerSessionKey(session.session_id, session.stream_key_id, session.label);

  return c.json({
    user_id: session.user_id,
    session_id: session.session_id,
    output_keys: session.output_keys,
  });
}
