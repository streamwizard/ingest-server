# ingest-media

The media plane for the StreamWizard ingest server. Accepts SRT and SRTLA from
IRL streamers, authorizes each connection against the Bun control plane, and
passthrough-relays (no transcode) the feed to OBS, which pulls it over SRT. It is
**pure libsrt over ctypes** — no GStreamer, no third-party Python packages.

## How it works

```
streamer ──SRT (streamid=in-key)─► srt_listener  ─┐
srtla_receiver ──SRT internal────► srt_listener   ┤─► authorize() ─► control plane
                                                  │        (returns output key[s])
                                                  ▼
                                         OutputChannel (per session)
                                                  ▲
OBS Media Source ──SRT (streamid=out-key)─► output_router :9000
```

- **Input** (`srt_listener.py`, `libsrt.py`): one libsrt listener socket per
  port accepts many callers; the `streamid` carries the incoming stream key.
  SRTLA arrives on an internal port fed by the Belabox `srtla_receiver` and is
  otherwise plain SRT — only the reported protocol label differs.
- **Relay** (`stream_relay.py`): reads MPEG-TS messages from the input socket
  and hands each to the session's `OutputChannel` — verbatim, no remux.
- **Output** (`output_router.py`): one shared SRT listener. An OBS Media Source
  connects as a caller with an *output key* as its `streamid`; the router matches
  it to the live stream's channel and attaches the socket. OBS connect/disconnect
  is decoupled from the streamer's session.
- **Auth** (`control_client.py`): every connect calls `POST /internal/authorize`
  with the incoming key; rejection closes the connection. The response carries
  the session id and the output key(s) the channel is registered under.

## Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `INGEST_CONTROL_URL` | — (required) | Base URL of the Bun control plane |
| `INGEST_CONTROL_SECRET` | — (required) | Shared secret for `/internal/*` |
| `INGEST_SRT_PORT` | `8888` | Public SRT ingest (UDP) |
| `INGEST_SRTLA_SRT_PORT` | `8889` | Internal SRT port fed by srtla_receiver |
| `INGEST_OUTPUT_PORT` | `9000` | SRT output OBS pulls from (UDP) |
| `INGEST_SRT_LATENCY_MS` | `4000` | SRT receiver-buffer latency on every listener |
| `INGEST_CONTROL_TIMEOUT` | `5` | Control-plane request timeout (s) |
| `INGEST_LOG_LEVEL` | `INFO` | Log level |

## Validation status

The control-plane auth flow is deterministic and unit-checkable. The **libsrt
ctypes binding (accept/streamid/recv/send) requires on-hardware validation** with
a running libsrt — see `docker/stream-server`. The accept/streamid path on both
the input and output listeners is the highest-risk piece.
