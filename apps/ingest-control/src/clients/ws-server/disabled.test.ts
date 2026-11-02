import { afterAll, expect, test } from "bun:test";

// rest-api answers the token route with 404 when the environment has no
// ws-server. The client must not dial, and must report "disabled" so the
// sampler leaves ws_broadcast_connected out instead of writing 0.
let upgrades = 0;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/ws") upgrades++;
    return Response.json({ error: "ws-server not configured" }, { status: 404 });
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { wsServerClient } = await import("./client");

afterAll(() => {
  wsServerClient.close();
  server.stop(true);
});

test("no ws-server configured: no dial, state is disabled", async () => {
  expect(wsServerClient.state()).toBe("disconnected");
  wsServerClient.connect();
  for (let i = 0; i < 200 && wsServerClient.state() !== "disabled"; i++) await Bun.sleep(5);
  expect(wsServerClient.state()).toBe("disabled");
  expect(upgrades).toBe(0);
});
