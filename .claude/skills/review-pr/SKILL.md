---
name: review-pr
description: Reviewing pull requests in this repo with a Fable reviewer agent - what to check against project rules, severity levels, posting inline review comments to GitHub, re-review and resolving threads. Use whenever reviewing a PR, re-reviewing after fixes, or deciding whether a PR is ready to merge.
---

# Review PR

Reviews run in a separate agent on the Fable model (`Agent` tool, `model: "fable"`), so the reviewer never shares the implementer's context. Process decision: ADR 0021.

## Spawning the reviewer

Prompt contains only: PR number, linked issue number, "load the `review-pr` skill and follow the Reviewer section", round number (and for re-reviews: commit SHA of the last review). Nothing from the implementer's reasoning.

## Reviewer

1. Read: `gh pr view <n>`, `gh pr diff <n>`, the linked issue (`gh issue view <N>`), `CLAUDE.md`, and the skills/ADRs the diff touches.
2. Check, in order:
   1. Acceptance criteria of the issue met, nothing beyond scope.
   2. Correctness: logic bugs, edge cases, invalid states reachable.
   3. Tests (`tdd` skill): written at the ticket's seams, test behavior not internals, literal expectations, no horizontal bulk.
   4. Design (`design` skill): deep modules, illegal states unrepresentable, branded IDs, functional core / shell, no speculative abstraction.
   5. Rules: domain terms (`domain`), brains pure + seeded (`simulation`), `Result` vs throw (`errors`), Zod at edges (`validation`), TS rules (`typescript`).
   6. Docs updated in the same PR (`docs`).
3. Verify before reporting: re-read the code around each finding, drop anything you can't point at a line for or that's preference without a rule behind it.
4. Severity, prefix every comment:
   - `[blocking]`: bug, rule violation, missing/weak test, missing docs. Must be fixed.
   - `[nit]`: optional improvement. Never blocks.
5. Never edit code, push, approve, or merge.

## Posting

One review per round, event `COMMENT` (author can't approve/request changes on own PR):

```bash
gh api repos/kludw/uber-simulator/pulls/<n>/reviews --input <review.json>
```

```json
{
  "commit_id": "<head sha from gh pr view <n> --json headRefOid>",
  "event": "COMMENT",
  "body": "Round <k>. Verdict: clean | changes needed. <one-line summary>",
  "comments": [
    { "path": "src/x.ts", "line": 42, "side": "RIGHT", "body": "[blocking] <problem>. <why, rule/skill>. <suggested fix>" }
  ]
}
```

`line` must be a line in the diff. Findings on unchanged code: put them in `body`. JSON file in scratchpad dir.

## Re-review

1. Review only changes since the last reviewed SHA (`git diff <sha>..<head>`), plus whether each earlier `[blocking]` is fixed.
2. Fixed threads: resolve them. Get thread IDs via GraphQL `repository.pullRequest(number).reviewThreads { nodes { id isResolved comments(first:1){nodes{body}} } }`, then `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>`.
3. `[nit]` threads: resolve too once reported (they never block). Merge requires all conversations resolved.

## Return to caller

Verdict (`clean` / `changes needed`), list of `[blocking]` findings (path:line + one line each), count of nits, review URL.
