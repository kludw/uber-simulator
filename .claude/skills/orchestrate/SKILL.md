---
name: orchestrate
description: Orchestrating ticket work as a manager - pick the next ready sub-issue, delegate implementation to a fresh agent with minimal context, run a Fable review, loop fixes, hand off to auto-merge, report. Use whenever asked to work through tickets, implement a milestone/parent issue, or "do the next ticket".
---

# Orchestrate

You are the manager. You don't write code or read whole diffs. You pick work, brief agents, judge their reports, and keep me informed. One ticket at a time. Process decision: ADR 0021.

## Loop (per sub-issue)

1. **Pick.** Next open sub-issue of the given parent, in sub-issue order (`gh api repos/kludw/uber-simulator/issues/<parent>/sub_issues`), board status Ready, not blocked by an open issue. Nothing ready -> stop, tell me.
2. **Start.** Set board status In progress (`tickets` skill). `git pull --ff-only` on `master`.
3. **Implement.** Spawn a fresh implementer agent (`Agent`, `subagent_type: "general-purpose"`, `isolation: "worktree"`). Brief below.
4. **Review.** Implementer returns a PR number. Set board status In review. Spawn a reviewer per `review-pr` skill (Fable).
5. **Fix loop.** Verdict `changes needed`: send the `[blocking]` list to the same implementer (`SendMessage`, keeps its context), then re-review. Max 3 rounds; still blocking -> stop, tell me with the open findings.
6. **Merge.** Verdict `clean` and all threads resolved: `gh pr ready <n>` then `gh pr merge <n> --auto --squash --delete-branch`. CI failure -> back to the implementer with the failing log excerpt (`gh run view --log-failed`).
7. **Close.** After merge: confirm issue closed + board Done, `git switch master && git pull --ff-only`. Report to me (below). Continue with next ticket unless told to stop after one.

## Implementer brief (give only this)

```
Implement issue #<N> in kludw/uber-simulator.
1. Read the issue: `gh issue view <N>`. It is your spec; its seams are already confirmed.
2. Read CLAUDE.md and load the skills it requires for this work (always: tdd, design, domain, docs, create-pr).
3. Branch `<N>-<kebab>` from origin/master, TDD red -> green -> refactor.
4. Open a draft PR per the create-pr skill. Do not mark ready, do not merge.
5. Blocked or the issue is ambiguous/wrong: stop and report the question. Don't guess.
Report: PR number, what you built (3 bullets max), commands run + results, open questions.
```

Add only facts the issue can't contain (e.g. "previous ticket introduced `Cell` in src/grid.ts"). Never paste conversation history, prior agents' reasoning, or full diffs.

## Judging reports

1. Implementer claims done: check `gh pr checks <n>` / PR body for verification evidence before spawning review. Missing evidence -> send back.
2. Implementer asks a question: answer from issue/spec/ADRs if it's clearly there; otherwise ask me. Never invent requirements.
3. Reviewer finding looks wrong: ask the reviewer to justify with the rule/line; don't silently drop it.

## Report to me per ticket

`#N <title>`: PR link, review rounds, merged yes/no, anything surprising (scope change, new ADR needed, follow-up ticket proposed). Two lines max unless something needs my decision.

## Stop and ask me when

Ticket contradicts spec/ADR and can't be resolved from them, CI failing for reasons outside the ticket, 3 review rounds without clean, or any destructive git operation would be needed.

New architecture decision: if I've delegated decisions to the manager, decide, write the ADR as Accepted (`docs` skill) in the ticket's PR or a separate docs PR, and report it. Otherwise propose and wait.
