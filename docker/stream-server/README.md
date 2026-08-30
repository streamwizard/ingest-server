# Stream-box ingest stack

Deploys the StreamWizard ingest server on the **Hetzner ingest VM**. It receives
SRT/SRTLA from streamers on its public interface and exposes a single SRT output
that the OBS servers pull from over **Tailscale** (the OBS boxes live elsewhere —
they are not part of this stack).

## Components

| Service | Image | Ports (host) | Role |
| --- | --- | --- | --- |
| `ingest-control` | `apps/ingest-control` (Bun) | internal `8090` | Validates stream keys against Supabase, resolves output keys, records sessions + metrics |
| `ingest-media` | `apps/ingest-media` (pure Python + libsrt) | `8888/udp` (SRT in), `9000/udp` (SRT out, Tailscale-only) | Authorizes + passthrough-relays feeds; routes OBS pulls by output-key streamid |
| `srtla-receiver` | Belabox `srtla_rec` | `5000/udp` (SRTLA) | Bonds SRTLA links → internal SRT (`ingest-media:8889`) |

There are no OBS containers on this box. OBS connects from the home/OBS server as
an SRT caller (a Media Source) to the output listener over Tailscale.

## Streamer ingest URLs (public)

- **SRT:** `srt://<box-host>:8888?streamid=<stream-key>`
- **SRTLA:** host `<box-host>`, port `5000`, with the SRT `streamid` set to `<stream-key>`

## OBS pull URL (over Tailscale)

In OBS, add a **Media Source** with:

```
srt://<vm-tailscale-ip>:9000?streamid=<output-key>&latency=300
```

The `output-key` must be an active row in `ingest_output_keys` paired with the
streamer's incoming key. The output port is published **only** on the Tailscale
interface, so it is never reachable from the public internet.

## Run

```bash
cp .env.example .env   # fill in DOPPLER_TOKEN, INGEST_CONTROL_SECRET, TAILSCALE_IP
docker compose up --build -d
docker compose logs -f
```

## Notes

- `INGEST_CONTROL_SECRET` must match across `ingest-control` and `ingest-media`
  (compose wires both from the same `.env` var).
- `TAILSCALE_IP` is the VM's Tailscale address; the `:9000` output port binds
  only to it. Leave it empty locally to publish on all interfaces for testing.
- `INGEST_SRT_INGRESS_LATENCY_MS` (default `4000`) is the receiver latency on the
  phone-facing listeners — the cellular retransmit budget. The legacy
  `INGEST_SRT_LATENCY_MS` name still works as a fallback for it.
- `INGEST_SRT_EGRESS_LATENCY_MS` (default `300`) is the receiver latency on the
  `:9000` output listener; the hop to OBS is server-to-server over Tailscale so
  it stays small. Match it on the OBS Media Source `latency=` query param — SRT
  negotiates the higher of the two sides.
- Pin the Belabox `srtla` revision in `srtla/Dockerfile` for reproducible builds.
- Live + global metrics are written to InfluxDB (set `INFLUXDB_*`, supplied via
  Doppler) and pushed live over WebSocket; durable session records go to Supabase.
