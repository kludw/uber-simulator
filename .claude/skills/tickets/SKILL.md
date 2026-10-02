---
name: tickets
description: Creating and managing work tickets - GitHub issues with sub-issues on the uber-simulator project board, ticket template, slicing work into PR-sized sub-issues, dependencies, status. Use whenever planning work, breaking down a milestone or feature, creating/editing issues or sub-issues, or picking the next ticket.
---

# Tickets

Tickets = GitHub issues in `kludw/uber-simulator`, tracked on project https://github.com/users/kludw/projects/4. Process decision: ADR 0021.

## Shape

1. Parent issue = one feature/slice of a spec milestone (`docs/spec.md`), e.g. "Driver brain: movement". Holds goal + context, no code-level detail.
2. Sub-issue = exactly one PR. Small vertical slice (TDD, see `tdd` skill): one or a few seams, reviewable in minutes.
3. Sub-issue order on the parent = execution order. Cross-ticket dependency: `Blocked by #N` line in body.
4. Titles: imperative, domain terms only (`domain` skill). E.g. "Move driver one cell toward target".

## Sub-issue body template

```markdown
Parent: #N

## Goal
One or two sentences: behavior that exists after this PR.

## Context
Links only: spec section, ADRs, skills. No copied content.

## Seams under test
- `functionName(input) -> output`: what is observed.

## Acceptance criteria
- [ ] Observable behavior 1 (concrete example: input -> expected output)
- [ ] Docs updated: <which, or "none">

## Out of scope
- What a reader might expect here but isn't.

Blocked by #M   <- only if applicable
```

Seams listed here count as the seam confirmation the `tdd` skill requires: the user confirms them when approving the ticket tree. Implementers don't need to re-confirm.

## Creating

1. Draft the full tree (parent + sub-issues) first. Show it, wait for my yes, unless I've delegated ticket approval to the manager (then the manager approves and reports the tree).
2. Parent: `gh issue create --title "<title>" --body-file <file>`.
3. Each sub-issue, in execution order: `gh issue create --title "<title>" --body-file <file> --parent <parentNumber>`.
4. Add every issue to the board: `gh project item-add 4 --owner kludw --url <issueUrl>`.
5. Body files go in the scratchpad dir, not the repo.

## Status

Board: project ID `PVT_kwHOBH_1j84Blddh`, Status field `PVTSSF_lAHOBH_1j84BlddhzhkKRLU`. Options:

| Status | Option ID | When |
| --- | --- | --- |
| Backlog | `f75ad846` | idea, not approved |
| Ready | `61e4505c` | approved, can be picked |
| In progress | `47fc9ee4` | implementer working |
| In review | `df73e18b` | PR open, under review |
| Done | `98236657` | PR merged / issue closed |

1. Item ID: `gh project item-add` returns it (`--format json --jq .id`), or find via `gh project item-list 4 --owner kludw --format json`.
2. Set: `gh project item-edit --project-id PVT_kwHOBH_1j84Blddh --id <itemId> --field-id PVTSSF_lAHOBH_1j84BlddhzhkKRLU --single-select-option-id <optionId>`.
3. Approved sub-issues go to Ready. The merged PR closes the sub-issue (`Closes #N`); set Done if the board didn't.
4. Close the parent when all sub-issues are closed.

## Changing tickets

Scope changes mid-work: edit the issue body (`gh issue edit N --body-file <file>`) and say what changed. Never silently widen a PR beyond its ticket. Spotted unrelated work: propose a new ticket, don't fold it in.
