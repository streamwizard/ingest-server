import { afterAll, beforeEach, expect, test } from "bun:test";

// The real client against a stub rest-api that records every request.
const seen: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let status = 202;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      body: (await req.json()) as Record<string, unknown>,
    });
    return Response.json({ ok: status < 400 }, { status });
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { broadcastSessionStats, broadcastNodeBandwidth } = await import("./events");
const { isRestApiReachable } = await import("./client");

const ID = "6953f34f-371a-4f0d-8377-f975c6f100a8";
async function waitForRequests(n: number) {
  for (let i = 0; i < 50 && seen.length < n; i++) await Bun.sleep(5);
}

beforeEach(() => {
  seen.length = 0;
  status = 202;
});
afterAll(() => server.stop(true));

test("a stats sample goes to rest-api with the node key, and names no user or node", async () => {
  broadcastSessionStats(ID, "srt", { kbps: 6000, loss_pct: 0.5 });
  await waitForRequests(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.path).toBe(`/api/ingest-nodes/sessions/${ID}/events`);
  expect(seen[0]!.auth).toBe(`Bearer ${process.env.NODE_API_KEY}`);
  expect(seen[0]!.body).toMatchObject({ type: "stats", protocol: "srt", stats: { kbps: 6000, loss_pct: 0.5 } });
  expect(seen[0]!.body).not.toHaveProperty("user_id");
  expect(seen[0]!.body).not.toHaveProperty("node_id");
});

test("node bandwidth goes to the node's own route", async () => {
  broadcastNodeBandwidth({
    ts: 1,
    rx_bytes_per_sec: 10,
    tx_bytes_per_sec: 20,
    tailscale_rx_bytes_per_sec: 0,
    tailscale_tx_bytes_per_sec: 5,
  });
  await waitForRequests(1);
  expect(seen[0]!.path).toBe("/api/ingest-nodes/me/metrics");
  expect(seen[0]!.body).not.toHaveProperty("node_id");
});

test("a refused event never throws into the caller and doesn't mark rest-api down", async () => {
  status = 404;
  expect(() => broadcastSessionStats(ID, "srt", {})).not.toThrow();
  await waitForRequests(1);
  await Bun.sleep(10);
  expect(seen).toHaveLength(1);
  expect(isRestApiReachable()).toBe(true);
});

test("a 5xx marks rest-api unreachable until the next good answer", async () => {
  status = 503;
  broadcastSessionStats(ID, "srt", {});
  await waitForRequests(1);
  await Bun.sleep(10);
  expect(isRestApiReachable()).toBe(false);

  status = 202;
  broadcastSessionStats(ID, "srt", {});
  await waitForRequests(2);
  await Bun.sleep(10);
  expect(isRestApiReachable()).toBe(true);
});

test("an id that can't be a path segment is dropped without a request", async () => {
  expect(() => broadcastSessionStats("..", "srt", {})).not.toThrow();
  await Bun.sleep(20);
  expect(seen).toHaveLength(0);
});
