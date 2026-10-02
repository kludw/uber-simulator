# 0012. Use Docker Compose for local infrastructure

- Status: Accepted
- Date: 2026-10-02

## Context

Local development needs ClickHouse and NATS running reproducibly with one command.

## Decision

We will run local infrastructure with Docker Compose (`compose.yaml`, official images, pinned tags, healthchecks, named volumes). The app runs on the host via Bun; containerizing it needs a separate decision. Rules: `.claude/skills/docker/SKILL.md`.

## Rationale

- One command brings up identical infra on any machine, so 'works on my machine' issues disappear.
- Official images and pinned tags make versions explicit and upgrades deliberate.
- Healthchecks + `--wait` ensure services are ready before the app connects.
- Keeping the app on the host keeps the edit-test loop fast; containerizing it can come later if deployment needs it.

## Alternatives considered

- Installing services natively: version drift across machines.
- Containerizing everything now: slower dev loop, not needed yet.

## Consequences

- `docker compose up -d --wait` brings up all infra.
- Docker required for development.
