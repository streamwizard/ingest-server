# StreamWizard Ingest Server

Standalone monorepo for the StreamWizard ingest stack.

## Apps

- `apps/ingest-control` - Bun/Hono control plane that authorizes stream keys, resolves output keys, and records ingest sessions + metrics.
- `apps/ingest-media` - Pure Python + libsrt media plane for SRT and SRTLA ingest, routing OBS pulls by output-key streamid.

## Supporting Packages

The `packages/*` workspaces are the shared TypeScript packages required by `ingest-control`.

## Docker Stack

The dedicated stream-box deployment lives in `docker/stream-server`.

```sh
docker compose -f docker/stream-server/docker-compose.yml up --build
```

For local development, copy `.env.example` to `.env` and fill in the ingest-related values.
