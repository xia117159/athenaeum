---
name: sfm-delivery-workflow
description: Coordinate non-trivial SimpleFileManager changes with requirements alignment, adaptive SDD, independent review gates, and TDD. Use for features, refactors, cross-module or high-risk changes, and design work that may lead to those changes; combine with narrower domain skills for implementation details.
---

# SFM Delivery Workflow

Own the delivery gates for a change without replacing relevant domain skills. Run alignment and risk routing first, use an available domain skill for implementation details when appropriate, then return to this workflow for conformance review and closure.

## Align Before Design

Before writing a specification or editing files:

1. Read `AGENTS.md` and enough relevant code, tests, contracts, and existing behavior to avoid asking questions the repository can answer.
2. State the understood goal, scope, constraints, and observable outcome.
3. Surface contradictions, missing information, risky premises, and decisions that could materially change behavior, scope, data safety, compatibility, cost, or architecture.
4. Ask the user about every material uncertainty. When several sound approaches exist, present their behavioral differences, tradeoffs, and risks, recommend one with reasons, and keep the recommendation distinct from the user's decision.
5. After material clarification, summarize the resulting task model, confirmed decisions, remaining disagreements, and known risks before proceeding.

Do not hide uncertainty in an assumption and treat it as user approval. Challenge an unsafe or incoherent request with concrete evidence. Do not manufacture questions when the task is clear. Choose internal, reversible details that do not change requirement semantics using established repository conventions.

Do not pass this gate while a material question is unanswered.

## Select the Lightest Sufficient Mode

Classify by uncertainty, blast radius, and consequence, not by line count alone.

- **Full SDD:** Use for new capabilities, cross-module changes, architecture or IPC changes, destructive behavior, shared state, concurrency, compatibility or migration work, broad refactors, or unclear verification.
- **Focused SDD:** Use for a bounded but non-trivial change. Keep the specification and review scope narrow, but retain both independent review gates.
- **Micro-SDD bug fix:** Use only when the root cause is evidenced, the effect is local, the regression boundary is understood, and one focused failing test can express the defect. No specification file or independent review gate is required unless risk grows.
- **Non-implementation task:** For explanation, diagnosis, status, review, or solution discussion, provide the requested analysis and do not edit or implement unless the user asks for a change.

Escalate to full SDD when the work affects destructive operations, shared state, cross-layer contracts, concurrency or stale async results, compatibility or migration, three or more modules, or cannot be bounded by a clear failing test. Escalate any lighter mode when investigation reveals wider risk or unresolved decisions.

## Handle Micro-SDD Bugs

Before the first code edit, tell the user the evidenced root cause, relevant code evidence, proposed fix and recommendation, expected failing test, and regression boundary. Root-cause evidence must connect the user's known reproduction conditions to the actual execution path. A defect that merely produces a similar symptom, or a domain skill's closest failing invariant, is only a candidate root cause.

If missing environment, entry point, protocol, or state would select a different code path or fix, return to the alignment gate unless evidence proves all plausible paths share the same cause. If there are materially different fixes, ask the user. If the root cause or boundary is not reliable, switch to formal SDD. These coordination gates take precedence over a domain skill's fallback localization rule. Then use Red-Green-Refactor and any applicable bug-fix domain skill. Adapt the presentation to the bug; do not force a template.

## Build an Adaptive Specification

For full or focused SDD, create `.temp/specs/<task-id>/spec.md`. All task-specific design documents, specifications, review records, and reports must remain under `.temp/` and are valid only during the task. This does not classify reusable project instruction assets such as `AGENTS.md` or Skill files as temporary task records.

Choose the document structure from the task's actual risks. Do not use a universal section template. The complete document must nevertheless give an independent implementer enough evidence to understand the problem, scope, relevant current behavior and constraints, intended observable behavior, meaningful risks, and how completion will be verified.

Add task-specific material only when useful. For example, a refactor needs evidenced current behavior, invariants, characterization coverage, migration boundaries, and regression protection; a bug needs symptom, root-cause evidence, test gap, and correction mechanism; a contract change needs both sides of the contract, serialization, errors, and compatibility behavior.

Unresolved material questions cannot be converted into hidden assumptions. After drafting the specification, read [references/review-workflow.md](references/review-workflow.md) completely and pass its specification review gate before implementation.

## Implement with Evidence

For code behavior changes, use Red-Green-Refactor:

1. Add or update a test that fails because the target behavior is absent or wrong.
2. Run it and confirm the failure reason is the intended one.
3. Implement the smallest coherent behavior change.
4. Run the focused test, then relevant regression suites.
5. Refactor only while tests remain green.

For behavior-preserving refactors, establish characterization tests or another observable baseline before changing structure. Keep each slice buildable and testable. Use the repository's existing architecture and the applicable domain skill when one is available; such skills are optional collaborators, not dependencies of this workflow.

For prompt, configuration, or documentation assets without meaningful runtime unit behavior, do not fabricate Red-Green. Use structural validation, trigger or routing checks, and independent forward scenarios instead.

For full or focused SDD, return to [references/review-workflow.md](references/review-workflow.md) after implementation and pass its implementation review gate.

## Budget the Implementation Review

Before the first implementation review, create one TODO ledger for the task and initialize an explicit counter such as `Implementation review budget: 0 / 5` for the initial budget stage. Use the ledger as the source of truth across context changes and sub-agent handoffs. Each finding needs a unique ID, severity, source wave/round, status, disposition, validation evidence, and any required user decision.

Process unresolved findings in priority order: blockers first, then serious findings, then general findings and suggestions. Low-priority work must not delay a required blocker or serious correction.

Count one round when an independent review wave has at least one successfully received report, all expected delegates have reports or explicit terminal states, its findings and coverage gaps are dispositioned in batch, and affected changes and validation are completed. A failed tool call, wave with no successful report, missing report before its deadline, timeout before review completion, or collaboration-slot retry does not consume a round. Do not split one wave, review, or finding into multiple rounds to evade the budget.

The initial implementation-review budget stage has a hard maximum of five rounds, generally reserved for large features, architecture changes, or refactors. Stop earlier when the gate is satisfied. When the counter reaches the current stage limit, stop automatic review regardless of low-priority findings. Unresolved blockers or serious findings mean the task is not complete; do not silently start another round. The user may explicitly accept the documented risk and close with `accepted-risk`, or explicitly expand the budget before a new budget stage; neither choice is automatic. An expansion must record the old and new limits, the user's authorization, reason, scope, and start the new counter at `0 / new_limit`; `accepted-risk` alone never expands the budget.

After delegating a sub-agent, treat each delegate as a potentially long-running work unit. Record its unique ID, delegation time, next check time, and terminal state; parallel delegates for one review use one frozen `review-wave-id` and expected delegate set. Check each work unit by default every 10 minutes, not repeatedly after a few seconds. Process proactive results, explicit errors, interruption, timeout, approaching task deadline, or a user-requested status immediately; a lack of new output alone is not evidence that work stopped.

## Complete the Task

Run validation proportional to the affected layers and the commands required by `AGENTS.md`. Report exact results and unresolved limitations. Durable behavior belongs in tests, types, contracts, error handling, and necessary code comments; do not promote the temporary specification into permanent documentation.

Do not claim a formal SDD task is complete while either independent review gate remains open.
