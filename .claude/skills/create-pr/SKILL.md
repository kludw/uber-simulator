---
name: create-pr
description: Creating pull requests for this repo - branch naming, pre-PR checks, commit messages, PR body template, draft until reviewed, then auto-merge after CI. Use whenever creating a branch for a ticket, committing work, opening a PR, or marking a PR ready to merge.
---

# Create PR

One PR = one sub-issue (`tickets` skill). Process decision: ADR 0021.

## Branch

1. From fresh `master`: `git switch master && git pull --ff-only && git switch -c <issueNumber>-<kebab-title>`, e.g. `12-move-driver-toward-target`.
2. Never commit to `master`: protected (PR required, CI check `check` required, branch must be up to date, conversations resolved).

## Before opening

All must pass locally, same as CI (`.github/workflows/ci.yaml`):

1. `bun run check` (Biome format + lint, writes fixes), then `bun run lint` clean.
2. `bun run typecheck`.
3. `bun run test`.
4. Docs updated per `docs` skill (README, spec, architecture, ADRs, skills).

## Commits

1. Imperative subject <= 72 chars, body says why when not obvious. Reference the issue: `Refs #N`.
2. Small commits following the TDD loop are fine; PRs squash-merge.
3. End each message with the attribution lines from the session's system instructions, if any.

## Open

1. `git push -u origin HEAD`.
2. `gh pr create --draft --title "<ticket title>" --body-file <file>` (body file in scratchpad dir):

```markdown
Closes #N

## What
Behavior added/changed, 1-3 bullets.

## How verified
- Commands run and results (`bun run test`: X pass, typecheck, lint).
- Acceptance criteria from #N, each checked.

## Docs
Files updated, or "none needed" + why.
```

3. Stays draft until `review-pr` reports no blocking findings.

## Ready to merge

Only after a clean review and all review threads resolved:

1. `gh pr ready <n>`.
2. `gh pr merge <n> --auto --squash --delete-branch`. Merges itself once CI passes.
3. CI fails: fix on the same branch, push. Never bypass checks, never force-push to `master`.
4. Branch behind `master`: `git fetch origin && git rebase origin/master`, rerun checks, `git push --force-with-lease`.
