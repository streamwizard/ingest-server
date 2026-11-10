import { afterAll, beforeEach, expect, test } from "bun:test";

// The real client against a stub rest-api. `reply` decides each answer.
const seen: { method: string; path: string; body: Record<string, unknown> }[] = [];
let reply: () => Response = () => Response.json({ ok: true });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      body: (await req.json()) as Record<string, unknown>,
    });
    return reply();
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { openSession, endSession, insertSessionStats } = await import("./sessions");

const ID = "6953f34f-371a-4f0d-8377-f975c6f100a8";

beforeEach(() => {
  seen.length = 0;
  reply = () => Response.json({ ok: true });
});
afterAll(() => server.stop(true));

test("openSession returns the opened session", async () => {
  const session = {
    session_id: ID,
    user_id: ID,
    stream_key_id: ID,
    label: "Camera 1",
    output_keys: ["out-1"],
  };
  reply = () => Response.json(session, { status: 201 });

  expect(await openSession({ protocol: "srt", stream_key: "k", remote_ip: "1.2.3.4" })).toEqual(session);
  expect(seen[0]).toMatchObject({
    method: "POST",
    path: "/api/ingest-nodes/sessions",
    body: { protocol: "srt", stream_key: "k", remote_ip: "1.2.3.4" },
  });
});

test("openSession turns a refused key (403) into null", async () => {
  reply = () => Response.json({ error: "Invalid stream key" }, { status: 403 });
  expect(await openSession({ protocol: "rtmp", stream_key: "bad" })).toBeNull();
});

test("openSession throws on any other failure", async () => {
  reply = () => Response.json({ error: "boom" }, { status: 500 });
  await expect(openSession({ protocol: "rtmp", stream_key: "k" })).rejects.toThrow();
});

test("endSession posts the last bitrate to the session's route", async () => {
  await endSession(ID, 4500);
  await endSession(ID);
  expect(seen.map((r) => [r.path, r.body])).toEqual([
    [`/api/ingest-nodes/sessions/${ID}/end`, { last_bitrate_kbps: 4500 }],
    [`/api/ingest-nodes/sessions/${ID}/end`, { last_bitrate_kbps: null }],
  ]);
});

test("a slash inside a session id is encoded, so it stays one path segment", async () => {
  await endSession("abc/../../me").catch(() => {});
  expect(seen[0]!.path).toBe("/api/ingest-nodes/sessions/abc%2F..%2F..%2Fme/end");
});

test("insertSessionStats sends the batch as rows", async () => {
  const rows = [{ session_id: ID, protocol: "srt" as const, recorded_at: "2026-11-02T00:00:00.000Z", kbps: 1 }];
  await insertSessionStats(rows);
  expect(seen[0]).toMatchObject({ path: "/api/ingest-nodes/session-stats", body: { rows } });
});
