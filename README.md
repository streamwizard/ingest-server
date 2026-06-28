# StreamWizard Ingest Server

Standalone monorepo for the StreamWizard ingest stack.

## Apps

- `apps/ingest-control` - Bun/Hono control plane that authorizes stream keys, records ingest sessions, and provisions OBS containers.
- `apps/ingest-media` - Python/GStreamer media plane for RTMP, SRT, and SRTLA ingest.

## Supporting Packages

The `packages/*` workspaces are the shared TypeScript packages required by `ingest-control`.

## Docker Stack

The dedicated stream-box deployment lives in `docker/stream-server`.

```sh
docker compose -f docker/stream-server/docker-compose.yml up --build
```

For local development, copy `.env.example` to `.env` and fill in the ingest-related values.
