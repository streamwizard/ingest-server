import { afterAll, beforeEach, expect, test } from "bun:test";

// One stub plays both rest-api (the token route) and ws-server (the upgrade),
// so the real client runs its full dial: token, then socket, then sends.
const upgrades: { role: string | null; auth: string | null }[] = [];
const received: Record<string, unknown>[] = [];
let tokenStatus = 200;
let tokensIssued = 0;

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/ingest-nodes/me/ws-token") {
      if (tokenStatus !== 200) return Response.json({ error: "nope" }, { status: tokenStatus });
      tokensIssued++;
      return Response.json({ token: `t${tokensIssued}`, ws_server_url: `ws://127.0.0.1:${srv.port}` });
    }
    if (url.pathname === "/ws") {
      upgrades.push({ role: url.searchParams.get("role"), auth: req.headers.get("authorization") });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(msg);
      if (msg.kind === "ping") ws.send(JSON.stringify({ kind: "pong", ts: msg.ts }));
    },
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { wsServerClient } = await import("./client");
const { broadcastSessionStats, broadcastNodeBandwidth } = await import("./events");

const ID = "6953f34f-371a-4f0d-8377-f975c6f100a8";

async function until(check: () => boolean, ms = 1000) {
  for (let waited = 0; waited < ms && !check(); waited += 5) await Bun.sleep(5);
}

beforeEach(() => {
  received.length = 0;
});
afterAll(() => {
  wsServerClient.close();
  server.stop(true);
});

test("sends before the socket is open are dropped, not thrown", () => {
  expect(() => broadcastSessionStats(ID, "srt", { kbps: 1 })).not.toThrow();
});

test("dials role=ingest-node with the token rest-api issued", async () => {
  wsServerClient.connect();
  await until(() => wsServerClient.state() === "connected");
  expect(wsServerClient.state()).toBe("connected");
  expect(upgrades).toEqual([{ role: "ingest-node", auth: "Bearer t1" }]);
});

test("a stats sample names the session but no user or node", async () => {
  broadcastSessionStats(ID, "srt", { kbps: 6000, loss_pct: 0.5 });
  await until(() => received.length > 0);
  expect(received[0]).toMatchObject({
    kind: "ingest_stats",
    session_id: ID,
    protocol: "srt",
    stats: { kbps: 6000, loss_pct: 0.5 },
  });
  expect(typeof received[0]!.at).toBe("string");
  expect(received[0]).not.toHaveProperty("user_id");
  expect(received[0]).not.toHaveProperty("node_id");
});

test("node bandwidth goes out without a node id", async () => {
  broadcastNodeBandwidth({
    ts: 1,
    rx_bytes_per_sec: 10,
    tx_bytes_per_sec: 20,
    tailscale_rx_bytes_per_sec: 0,
    tailscale_tx_bytes_per_sec: 5,
  });
  await until(() => received.length > 0);
  expect(received[0]).toMatchObject({ kind: "node_metrics", payload: { ts: 1, rx_bytes_per_sec: 10 } });
  expect(received[0]!.payload).not.toHaveProperty("node_id");
});
