import { type Context } from "hono";
import { z } from "zod";
import { supabase } from "@repo/supabase";
import { getStreamKeyOwner, touchStreamKey, insertIngestSession, getOutputKeysForKey } from "@repo/supabase/queries/ingest";

const bodySchema = z.object({
  protocol: z.enum(["rtmp", "srt", "srtla"]),
  stream_key: z.string().min(1),
  remote_ip: z.string().optional(),
});

/**
 * POST /internal/authorize
 *
 * Called by the media plane the moment a streamer connects. Validates the
 * stream key, opens an ingest session, and returns the output key(s) under
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

  const owner = await getStreamKeyOwner(supabase, body.stream_key);
  if (!owner) {
    return c.json({ error: "Invalid stream key" }, 403);
  }

  // Best-effort last-used bump; never blocks the connection.
  void touchStreamKey(supabase, body.stream_key);

  const { data: session, error } = await insertIngestSession(supabase, {
    user_id: owner.user_id,
    key_id: owner.key_id,
    protocol: body.protocol,
    remote_ip: body.remote_ip ?? null,
  });

  if (error || !session) {
    return c.json({ error: "Failed to open session" }, 500);
  }

  const outputKeys = await getOutputKeysForKey(supabase, owner.key_id);

  return c.json({
    user_id: owner.user_id,
    session_id: session.id,
    output_keys: outputKeys,
  });
}
