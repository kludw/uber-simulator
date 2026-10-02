# 0021. Development workflow: GitHub issues, agent-orchestrated PRs, CI-gated auto-merge

- Status: Accepted
- Date: 2026-10-02

## Context

Work is mostly done by Claude agents, one owner reviews direction. The repo is `kludw/uber-simulator` with a linked GitHub project (https://github.com/users/kludw/projects/4). A solo author cannot approve their own PRs, so an approval requirement would be either theater (bot approval) or a blocker.

## Decision

We will:

- Track work as GitHub issues: parent issue per feature slice, native sub-issues, one sub-issue = one PR, all on project 4.
- Run CI on GitHub Actions (`.github/workflows/ci.yaml`, job `check`): Biome CI, typecheck, tests.
- Protect `master`: PR required, `check` required and branch up to date, conversations resolved, no force-push, enforced for admins, 0 approvals required.
- Review every PR with a separate Fable-model agent posting inline comments; blocking findings must be fixed and threads resolved.
- Squash auto-merge once CI passes and the review is clean.
- Orchestrate one ticket at a time: a manager agent briefs fresh implementer agents with minimal context.

Rules: `.claude/skills/{tickets,create-pr,review-pr,orchestrate}/SKILL.md`.

## Rationale

- Issues + project board give a visible, portfolio-friendly history and a natural PR-sized unit of work.
- Required CI plus required conversation resolution enforce quality mechanically; no auto-approve bot needed.
- A reviewer on a different model with no shared context catches what the implementer rationalized.
- Minimal agent briefs keep implementers focused on the ticket and force tickets to be self-contained.
- One ticket at a time avoids merge conflicts while conventions are still settling.

## Alternatives considered

- Auto-approve workflow + 1 required approval: the approval would mean nothing.
- Owner merges every PR manually: more control, slower; owner chose auto-merge.
- Local markdown tickets: nothing visible on GitHub.
- Parallel implementers: faster, more conflicts; revisit once the codebase stabilizes.

## Consequences

- Merges happen without the owner looking; quality rests on CI, tests, and the Fable review.
- Tickets must be precise (seams, acceptance criteria) since implementers get nothing else.
- `gh` needs the `project` scope for board updates.
