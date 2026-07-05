import { env } from "./lib/env";
import { Hono } from "hono";
import { metricsMiddleware, isMetricsEnabled } from "@repo/metrics";
import { internalAuth } from "./middleware/internal-auth";
import { authorizeHandler } from "./routes/authorize";
import { sessionEndHandler } from "./routes/session-end";
import { sessionStatsHandler, getSessionStatsHandler, startSessionStatsFlusher } from "./routes/session-stats";
import { wsBroadcastClient } from "./lib/ws-broadcast";
import { startSystemMetricsSampler } from "./services/system-metrics-sampler";

const app = new Hono();

app.use("*", metricsMiddleware("ingest-control"));

app.get("/", (c) => c.json({ message: "StreamWizard Ingest Control", version: "1.0.0" }));

// Internal control-plane API — only the media plane calls these, guarded by the
// shared secret and only reachable on the private compose network.
app.use("/internal/*", internalAuth);
app.post("/internal/authorize", authorizeHandler);
app.post("/internal/session-end", sessionEndHandler);
app.post("/internal/session-stats", sessionStatsHandler);
app.get("/internal/session-stats/:sessionId", getSessionStatsHandler);

startSessionStatsFlusher();
wsBroadcastClient.connect();
startSystemMetricsSampler(env.INGEST_NODE_ID);

Bun.serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`[ingest-control] listening on port ${env.PORT}`);
console.log(`[metrics] ${isMetricsEnabled() ? "active — sending to " + process.env.INFLUXDB_URL : "disabled — set INFLUXDB_* env vars to enable"}`);
