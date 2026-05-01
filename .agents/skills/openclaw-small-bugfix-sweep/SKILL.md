---
name: openclaw-small-bugfix-sweep
description: Fix only small, high-certainty OpenClaw bugs from a pasted issue/PR list after deep code review.
---

# OpenClaw Small Bugfix Sweep

Batch workflow for pasted OpenClaw issue/PR refs.
Execute, do not summarize.

## Companion Skills

Use `$gitcrawl` first, `$openclaw-pr-maintainer` for live GitHub hygiene, `$github-deep-review` posture for source tracing, and `$openclaw-testing` for proof.

## Loop

For each ref:

1. Read live target with `gh`.
2. Check `gitcrawl` for related, duplicate, closed, or already-fixed threads.
3. Read body, comments, linked refs, changed files, current code, adjacent tests, and dependency contracts when relevant.
4. Trace the real runtime path.
5. Fix only if this is a bug, current code proves root cause, the implicated path is clear, and a narrow patch is cleaner than refactor.
6. Add focused regression proof when practical.
7. Run the smallest meaningful gate.
8. Continue until every pasted ref is fixed or skipped.

No subagents unless explicitly requested.

## Skip If

- not a bug
- config/docs/workflow/release/support/dependency/product work
- repro or root cause is uncertain
- larger refactor or owner-boundary change is cleaner
- already fixed on current `main`
- dependency behavior is guessed
- no focused proof is feasible

Skip with terse reason. Do not pad with low-confidence fixes.

## Fix Rules

- owner module first; generic seam only when required
- existing patterns/helpers/types
- no drive-by refactors
- tests near failing surface
- docs only for changed public behavior
- no comment/close/label/land/merge unless explicitly asked

## Output Shape

Ledger: `fixed`, `skipped`, `needs-human`.
Final: refs, URLs, files, tests/gates, skip reasons.
