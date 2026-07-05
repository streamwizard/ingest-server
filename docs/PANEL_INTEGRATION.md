# Panel integration: node linking

This describes the Wings-style "add a node, get an install command, run it,
node links itself" flow for ingest-server, mirroring the equivalent flow
already built for `obs-instance-manager`. The panel side (the piece that
creates `ingest_nodes` rows and issues claim tokens) lives in the
`streamwizard` monorepo's `rest-api` app, not in this repo — this doc is the
contract that app implements. `scripts/install.sh` in this repo speaks this
protocol on the node side (`--rest-api-url` / `--token` flags) and falls back
to manual `.env` setup when they're omitted.

## Why this differs from obs-instance-manager

`ingest-control` talks to Supabase **directly** with a service-role key
(`SUPABASE_URL`/`SUPABASE_SECRET_KEY`), unlike obs-instance-manager, which
now goes through `rest-api`'s node-scoped endpoints using a bearer
`NODE_API_KEY`. That means the claim response for an ingest node has to hand
out the raw `SUPABASE_SECRET_KEY` — full service-role database access — not
just a narrowly-scoped credential. This is a materially bigger blast radius
if a claim token leaks or gets replayed against the wrong box, so:

- The claim token TTL is **15 minutes** here, tighter than obs-instance-manager's 30.
- `/api/ingest-nodes/claim` is only ever served over HTTPS in deployed environments.
- Each box also gets its own freshly-minted `INGEST_CONTROL_SECRET` at claim
  time (replacing today's single Doppler-shared value) — `ingest-control` and
  `ingest-media` on the same box both read it from the same root `.env`
  (`env_file: ../../.env` in `docker/stream-server/docker-compose.yml`), so
  one fresh value per claim is enough to give every box its own secret with
  no extra coordination needed between the two processes.

There's also no GPU concept at all here (no `gpu_bus_id`, no NVIDIA toolkit
install step) and no per-node `api_url` — nothing calls into an ingest node's
own HTTP API (it's deliberately never published; see the firewall section of
`scripts/install.sh`), so there's nothing for the panel to reach.

## Automated Tailscale join

Unlike obs-instance-manager, ingest boxes need Tailscale (the SRT output OBS
pulls from is only reachable over the tailnet). Rather than requiring the
admin to paste a manually-generated auth key into the install command,
`rest-api` mints one itself during `/claim`, using a **Tailscale OAuth
client** scoped to the `auth_keys` capability and restricted to
`tag:ingest-node` (`TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET`
env vars). The minted key is:

- `reusable: false` — single-use, can't be replayed for a second device
- `preauthorized: true` — skips manual device approval
- tagged `tag:ingest-node` — the OAuth client is structurally incapable of
  minting a key for any other tag, so a leaked `rest-api` secret can't be
  used to add arbitrary devices to the tailnet
- short-lived (~1 hour) — it's only ever needed for the one `tailscale up`
  call `install.sh` makes right after the claim response arrives

This is non-fatal on failure: if the Tailscale API is unreachable or
misconfigured, `/claim` still succeeds and returns `tailscale_authkey: null`;
`install.sh` warns and falls back to requiring a manual `tailscale up` +
firewall rule, rather than failing the whole claim over a Tailscale hiccup.

`install.sh` still accepts `--tailscale-authkey=` as a flag, but only for the
manual/no-panel fallback path (no `--rest-api-url`/`--token` given). When
doing a full claim, the flag is ignored in favor of the panel-minted key —
which also means the script joins Tailscale *after* the claim call, not
before, since the key doesn't exist until then.

## Flow

1. **Admin creates a node in the panel UI.** Panel inserts a row into
   `ingest_nodes` with `status = 'pending'`, the admin-chosen fields (`name`,
   `max_concurrent_sessions`), and a freshly generated **claim token**. Only
   a SHA-256 hash of the token is stored, with a 15-minute expiry — the same
   password-reset-token pattern obs-instance-manager uses.

   Everything else about the physical node — `hostname`, `cpu_cores`,
   `ram_total_mb`, `storage_total_mb`, `public_ip`, `lan_ip`, `tailscale_ip` —
   is left blank at creation time; the node reports these facts about itself
   during claim, since they can't be known until the node calls in.

2. **Panel shows an install command**, e.g.:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/streamwizard/ingest-server/main/scripts/install.sh \
     | sudo bash -s -- --rest-api-url=https://api.example.com --token=<claim-token> --start
   ```

   No Tailscale auth key needs to be generated or pasted in — see "Automated
   Tailscale join" above.

3. **Admin runs that command on the new VPS.** `install.sh` provisions the
   host (Tailscale, Docker, ufw, `ingest` service user,
   `/opt/ingest-server` checkout) and then calls:

   ```
   POST {rest-api-url}/api/ingest-nodes/claim
   Content-Type: application/json

   {
     "token": "<claim-token>",
     "cpu_cores": 8,
     "ram_total_mb": 16384,
     "storage_total_mb": 102400,
     "public_ip": "203.0.113.10",
     "lan_ip": "10.0.0.5",
     "tailscale_ip": null
   }
   ```

   (`cpu_cores` from `nproc`, `ram_total_mb` from `/proc/meminfo`,
   `storage_total_mb` from `df` on the root filesystem, `public_ip` from an
   external echo service with `--public-ip` as a manual override, `lan_ip`
   from the primary interface's own address (same as `public_ip` on most VPS
   providers; distinct on providers with a separate private network),
   `tailscale_ip` from `tailscale ip -4` — usually `null` here, since Tailscale
   isn't joined yet at claim time in the automated flow; it gets filled in
   locally, after joining, directly into `.env` rather than reported back to
   the panel.) This lives in `rest-api` for the
   same reason as obs-instance-manager's claim route: it's a
   machine-to-machine endpoint hit by a fresh, untrusted VM with nothing but
   a one-time token, and `ingest-control` itself can't host its own bootstrap
   endpoint — it doesn't have `SUPABASE_SECRET_KEY` configured yet, which is
   exactly what claiming is supposed to deliver.

4. **rest-api validates and responds.** Look up the pending node by token
   hash, reject if expired/already claimed/not found (`404`/`409`/`410`). On
   success: mark the token consumed, fill in the self-reported fields on the
   row, slugify the node's `name` into a `hostname`, mint a fresh
   `INGEST_CONTROL_SECRET`, a `node_api_key` (unused today, written for
   forward-compat with a future heartbeat endpoint), and a Tailscale auth key
   (see "Automated Tailscale join" above; `null` if the Tailscale API call
   failed), set `status = 'linked'`, and return (actual current shape, see
   `apps/rest-api/src/routes/ingest-nodes.ts`):

   ```json
   {
     "node_id": "<uuid, the ingest_nodes.id>",
     "hostname": "ingest-box-1",
     "node_api_key": "<unused today, forward-compat>",
     "ingest_control_secret": "<fresh per-box shared secret>",
     "tailscale_authkey": "<single-use, tag:ingest-node key, or null>",
     "supabase_url": "https://xxxx.supabase.co",
     "supabase_secret_key": "<service-role key>",
     "rest_api_url": "https://api.example.com"
   }
   ```

5. **Node joins Tailscale** using `tailscale_authkey` (if present), **then
   writes `.env`** (at the repo root — `docker/stream-server/docker-compose.yml`'s
   `env_file: ../../.env` resolves relative to the compose file's own
   directory, not the caller's working directory) from the claim response
   plus its own just-acquired Tailscale IP, plus static defaults for the
   remaining vars in `.env.example`, and **sets its own hostname** (both
   Linux and Tailscale) to the returned `hostname` before building/starting
   the stack — same "no manual rename step" reasoning as obs-instance-manager.

## Non-goals (for now)

- **No multi-node session routing.** `ingest_stream_keys`/`ingest_sessions`/
  `ingest_session_stats`/`ingest_output_keys` remain per-user tables with no
  `node_id` FK. This registration flow gives fleet visibility and
  provisioning, not load-balanced request routing across boxes.
- **No live health polling.** `ingest-control`'s HTTP port is never published
  by docker-compose, so there's nothing for the admin's browser to reach —
  unlike obs-instance-manager's `GET /admin/metrics/stream`. The admin UI
  shows only the DB `status` enum (`pending`/`linked`/`disabled`). A real
  heartbeat (ingest-control periodically calling a `rest-api` endpoint with
  its `node_api_key`) would be the natural way to add this later.
- **No per-node detail page.** The admin list page is the only surface for
  v1; `node_api_key`/`ingest_node_api_keys` exist purely for that future
  heartbeat, unused by anything today.
