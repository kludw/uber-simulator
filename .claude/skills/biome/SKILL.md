---
name: biome
description: Biome linting and formatting reference for this project. Use whenever linting, formatting, organizing imports, configuring biome.json, fixing lint/format errors, or finishing a code change.
---

# Biome (https://biomejs.dev)

1. Installed pinned: `bun add -D -E @biomejs/biome`. Config via `bunx --bun @biomejs/biome init` (`biome.json`).
2. Format + lint + organize imports, apply safe fixes: `bunx --bun @biomejs/biome check --write`.
3. Format only: `bunx --bun @biomejs/biome format --write`. Lint only: `bunx --bun @biomejs/biome lint --write`.
4. CI (read-only): `bunx --bun @biomejs/biome ci`.
5. Run `check --write` before declaring a cycle done. Lint/format errors = not done.
