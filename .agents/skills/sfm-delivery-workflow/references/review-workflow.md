# Formal SDD Review Workflow

Read this reference only for full or focused SDD. Both modes use the same gates; focused SDD reduces document breadth and review rounds, not independence.

## Reviewer Independence

Use an independent sub-agent for each review pass. Give it the original request, current specification or implementation diff, scope clues, and known validation results. Do not prime it with the intended conclusion or restrict it to evidence selected by the primary agent. Authorize it to inspect relevant source, tests, contracts, and history as needed.

The reviewer treats the specification and repository implementation as read-only. It may write only one uniquely named report under:

```text
.temp/specs/<task-id>/reviews/<review-id>.md
```

Tell it not to edit reviewed files or run formatters, generators, fixers, or other commands that rewrite the repository. If a prototype or test implementation is needed, make that a separate, explicitly bounded task rather than part of review.

## Specification Review Gate

Ask the reviewer to inspect both whether the proposed behavior is sound and whether the chosen specification content is sufficient for this particular task. It should look for material omissions, contradictions, unverifiable outcomes, unjustified assumptions, architecture or contract problems, data-safety concerns, and missing regression boundaries.

The primary agent owns every disposition:

- Accept and revise the specification.
- Partially accept, explaining the supported adjustment.
- Reject with concrete evidence.
- Escalate a material product or engineering choice to the user.

A question awaiting the user is unresolved, not disposed. After a material revision to behavior, scope, contract, technical design, key assumptions, risk controls, or verification evidence, obtain another independent pass when it can materially reduce remaining risk.

The specification gate closes only when there are no unresolved blockers or material user decisions, key behavior is verifiable, implementation boundaries are clear, every material finding has a completed disposition, and another pass is not expected to meaningfully reduce risk. Do not review merely to reach a fixed round count.

## Implementation Review Budget

The initial implementation-review budget stage has a hard maximum of five rounds. This budget applies only to the post-implementation review, correction, and validation cycle; specification review does not consume it. Five rounds is normally reserved for large features, architecture changes, and refactors. A smaller task may use fewer rounds and should stop as soon as the gate is satisfied. Without explicit user authorization, no budget stage may exceed its recorded limit.

At the start of implementation review, create one TODO ledger and show an explicit counter such as:

```text
Implementation review budget: 0 / 5
Blockers: 0 unresolved
Serious: 0 unresolved
General: 0 open, 0 deferred
```

The ledger is the source of truth across context changes and handoffs. Each item records a unique ID, severity, source wave/round, description, impact, status, disposition, validation evidence, and whether a user decision is required. Deduplicate new findings against existing IDs and batch the current wave's dispositions and fixes.

Use these minimum severity criteria and record the reason for classification:

| Level | Criteria | Default handling |
| --- | --- | --- |
| Blocker | Build or key test failure; core acceptance failure; data loss or security risk; broken IPC, compatibility, or critical contract; or inability to prove the main user path safe | Must be fixed and verified; cannot be silently deferred |
| Serious | Critical workflow regression; missing critical error handling; high-probability impact to a primary user path; important architecture/concurrency defect; or a critical missing test not yet blocking | Must be fixed by default; otherwise requires explicit user risk acceptance |
| General | Local non-core defect or limited regression that does not change primary acceptance or safety boundaries | May be fixed or deferred with a reason |
| Suggestion | Optional quality, maintainability, readability, or experience improvement | May be deferred or rejected with a reason |

`open`, `in_progress`, and `blocked` are unresolved statuses. `fixed` closes an item only with passing affected validation. `deferred` and `rejected` are for general findings and suggestions; a blocker or serious finding may close only as verified `fixed` or explicitly user-approved `accepted-risk`. An unresolved material user decision remains unresolved. If reviewer and primary agent disagree on severity, use specification, code, test, and risk evidence to reclassify and record the reason.

Count one round when an independent review wave has at least one successfully received report, all expected delegates have reports or explicit terminal states, its findings and coverage gaps are dispositioned in batch, and affected modifications and validation are completed, even if no code changed. A wave with no successful report, tool failure, missing report before its deadline, an incomplete review due to timeout, or a collaboration-slot retry does not consume a round. If partial coverage remains, record the missing delegate and impact; keep the wave incomplete or obtain explicit user acceptance of the coverage risk before counting it. Do not split waves, reviewers, or findings to evade the budget.

Each review wave is an immutable execution record with a unique `review-wave-id`, source round, and frozen set of expected logical delegate IDs. A retry keeps the same logical delegate ID and replaces only its attempt record. A wave completes only after each member has a report or explicit `completed`, `error`, `interrupted`, or `timeout` terminal state and the coverage gap has been dispositioned. If every member fails or times out without a report, do not increment the budget. A late report or duplicate report always attaches to the original wave and never creates a new round; if it adds a new blocker or serious finding, add it to the TODO ledger and schedule a later wave only if the current stage still has budget, otherwise apply the current-stage-limit incomplete rule.

If the user explicitly expands the budget, record the old limit, new positive limit, user authorization or quoted decision, reason, scope, and creation time of the new budget stage. Start its counter at `0 / new_limit`; do not display `n / old_limit`. Create the new stage only after the current stage has stopped or completed, unless the user explicitly requests reopening it. A change to the target behavior, scope, contract, or risk boundary returns to requirements alignment and any needed specification review. `accepted-risk` closes only the named finding and never expands the budget; a user saying only “continue”, “look again”, or “fix it” is not expansion authorization.

## Implementation Review Gate

After implementation and relevant validation, give an independent reviewer the original request, converged specification, repository diff, and exact test or validation results. Require two separate conclusions:

1. **Conformance:** Check each observable requirement and acceptance claim against implementation and evidence. Identify omissions, unintended behavior, and unsupported claims.
2. **Engineering quality:** Apply the relevant repository conventions and available domain skills to architecture, error handling, safety, maintainability, regression risk, and test quality.

Adapt the quality dimensions to the work. Prompt assets need instruction clarity, routing, conflict, and forward-scenario checks; ordinary application code does not need prompt-specific checks. A filesystem operation needs stronger path, conflict, and data-loss analysis than a local visual adjustment.

Process findings in priority order: blockers, serious findings, general findings, then suggestions. Batch blocker and serious corrections in the same wave when possible; record lower-priority items as deferrable rather than allowing optional quality work to delay required fixes.

The reviewer retains the same read-only boundary. The primary agent evaluates each finding, makes supported corrections, reruns affected validation, updates the TODO ledger, and requests another review when the correction materially changes behavior, contracts, architecture, risk controls, or verification. Later reviews should focus on previous blocker/serious fixes and the affected regression surface; do not reopen closed low-priority items without new evidence.

The implementation gate closes only when the TODO ledger contains no unresolved blocker or serious item, conformance is evidenced, engineering-quality findings have completed dispositions, and validation covers the resulting change. This condition is based on severity and status in the ledger, not on whether a reviewer used the label `blocking finding`.

Stop early when the gate is satisfied and another round is not expected to materially reduce risk. When the counter reaches the current budget stage's `limit` (5 in the initial stage), stop automatic review regardless of lower-priority findings:

- If no blocker or serious item is unresolved, complete normally or report completion with explicitly deferred/rejected low-priority items.
- If any blocker or serious item remains unresolved, report the implementation review as not passed and the task as incomplete. List each item, evidence, risk, and the user decision needed. The user may explicitly accept the documented risk and close with `accepted-risk`, or explicitly expand the budget into a new stage before any additional round; do not start another round in the current stage without the latter. An accepted risk does not itself authorize a new round.
- If changes in the final round of the current stage introduce a new blocker or serious item, the same incomplete rule applies.

## Delegate Polling

After delegating a reviewer, treat each delegate as a separate potentially long-running work unit. Record a unique delegate ID, delegation time, next check time, and terminal state in the TODO ledger or adjacent execution log, and group parallel delegates for one review under a frozen `review-wave-id` and expected delegate set. Check each delegate by default every 10 minutes. Ten minutes is a default polling interval, not a mandatory sleep: process a proactive result, explicit error, interruption, timeout, approaching task deadline, or user-requested status immediately. Do not repeatedly query after a few seconds or infer that no work is happening from a lack of new output. A temporary lack of results means wait for the next check or continue independent work.

## Unavailable Delegation

If collaboration capacity is temporarily busy, wait and retry. If independent delegation is unavailable in the environment, do not label self-review as independent review and do not claim the formal SDD workflow is complete. Report the unpassed gate and limitation. Skip it only after the user explicitly accepts that exception.
