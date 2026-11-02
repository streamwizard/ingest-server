import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(8090),

  // The panel's rest-api. Every database read/write and every live event goes
  // through it, authenticated with this node's own API key from the claim flow
  // (see clients/streamwizard-api/client.ts).
  REST_API_URL: z.string().url(),
  NODE_API_KEY: z.string().min(1),

  // Shared secret the media plane must present on every internal call.
  INGEST_CONTROL_SECRET: z.string().min(1),

  // ingest_nodes.id from the claim flow (see docs/PANEL_INTEGRATION.md) —
  // tags this node's host metrics so they're attributable in InfluxDB.
  // Older installs wrote the id as NODE_ID, so fall back to that before
  // giving up with "unknown-node" (local/dev boxes that never claimed).
  INGEST_NODE_ID: z.string().default(process.env.NODE_ID || "unknown-node"),
});

export const env = schema.parse(process.env);
