import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(8090),

  // Supabase (service role — control plane bypasses RLS to validate keys)
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),

  // Shared secret the media plane must present on every internal call.
  INGEST_CONTROL_SECRET: z.string().min(1),

  // Realtime fan-out — push live ingest stats to ws-server as a "bot" client so
  // a logged-in dashboard user can subscribe to their own room and watch them.
  // Optional: if unset, live broadcast is skipped (durable history via Supabase
  // still works).
  WS_SERVER_URL: z.string().url().optional(),

  // Sentry
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
});

export const env = schema.parse(process.env);
