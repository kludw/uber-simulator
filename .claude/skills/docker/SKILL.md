---
name: docker
description: Docker and Docker Compose for local infrastructure (ClickHouse, NATS) - compose.yaml conventions, startup order, healthchecks, volumes, commands. Use whenever editing compose.yaml or Dockerfiles, starting/stopping/resetting local services, or adding a new service/container.
---

# Docker (https://docs.docker.com)

Do not rely on your training data. Before using any Compose attribute, Dockerfile instruction, or CLI flag not listed below: find the page in https://docs.docker.com/llms.txt (Compose file reference: https://docs.docker.com/reference/compose-file/, CLI: https://docs.docker.com/reference/cli/docker/compose/), follow it. Image-specific config (env vars, ports, volumes, flags): the image's official Docker Hub page. Docs win over this file. Obsolete/deprecated per docs = don't use. Unsure + no doc found = ask me.

Snapshot verified against docs.docker.com, Docker Hub pages for `nats` and `clickhouse/clickhouse-server`, and local `docker compose --help` (Compose v5.5.1) on 2026-10-02. If docs now differ, follow docs and flag it.

## Scope

1. Compose runs local infra: ClickHouse, NATS. App (sim, adapters) runs on host via Bun (see `bun` skill).
2. Containerizing the app (Dockerfile) = not yet. Ask me before adding.

## Compose file

1. One file: `compose.yaml` at repo root (docs: preferred default name). Not `docker-compose.yml`.
2. No top-level `version:` (obsolete per Compose file reference).
3. Pin image tags to a version, not `latest`. Pick the current version from the image's Docker Hub page.
4. Secrets/credentials via env (`.env`, git-ignored; commit a `.env.example`). Same env names the app validates with Zod (see `validation` skill).
5. Named volumes for data, so `down` keeps it and `down -v` resets it.

## Startup order

1. Dependent service waits for health: `depends_on: { svc: { condition: service_healthy } }` + `healthcheck:` on `svc`.
2. Healthcheck command must exist inside the image. Verify from the image docs before writing one; don't assume `curl`/`wget` are present.

## Services (from official image docs)

1. **NATS** (`nats`, see `nats` skill): `-alpine` tag, since the default image is scratch (only `/nats-server`, no shell/wget); alpine has busybox `wget` for the healthcheck on `http://localhost:8222/healthz`. Ports 4222 clients, 8222 HTTP monitoring, 9222 websocket. Config file `infra/nats.conf` mounted at `/etc/nats/nats-server.conf` (JetStream `store_dir: /data` + volume on `/data`, websocket).
2. **ClickHouse** (`clickhouse/clickhouse-server`, see `clickhouse` skill): ports 8123 HTTP (client uses this), 9000 native. Env `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`. Data volume on `/var/lib/clickhouse/`. Docs run it with `ulimits: nofile 262144`.

## Commands

1. Start + wait until healthy: `docker compose up -d --wait`.
2. Logs: `docker compose logs -f <svc>`. Status: `docker compose ps`.
3. Stop: `docker compose down`. Reset data: `docker compose down -v` (destroys volumes, ask me first).
4. `docker compose` (plugin), not legacy `docker-compose`.
