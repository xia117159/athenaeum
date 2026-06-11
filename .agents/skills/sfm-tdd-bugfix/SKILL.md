---
name: sfm-tdd-bugfix
description: Fix bugs in the SimpleFileManager Tauri v2, Rust, React, and TypeScript codebase using mandatory root-cause analysis and TDD. Use when handling regressions, broken UI behavior, incorrect file operations, IPC failures, state bugs, build/test failures, or any request described as a bug fix.
---

# SFM TDD Bugfix

## Workflow

1. Read `AGENTS.md`, `.temp/design.md` or `docs/design.md`, and the smallest relevant source/test files before changing code.
2. Reproduce or localize the failure. If the bug is user-reported and cannot be executed locally, identify the closest failing invariant in code.
3. State the root cause in concrete terms: bad state transition, contract drift, unsafe path handling, stale async result, UI layout regression, encoding problem, or missing validation.
4. Add or update a failing test first:
   - Frontend behavior: `src/features/workspace/*.test.tsx` or `*.test.ts`.
   - Gateway/mapper/planner behavior: `workspaceGateway.test.ts` or the extracted module test.
   - Rust services/commands: `#[cfg(test)]` module near the affected service.
5. Implement the smallest fix that preserves the current architecture path under `src/features/workspace/*` and `src-tauri/src/{commands,services,domain}`.
6. Refactor only after the test is green, and keep unrelated churn out of the diff.
7. Run validation:
   - `npm test`
   - `npm run build`
   - `cargo test --manifest-path src-tauri/Cargo.toml --offline` when `cargo` is available

## Bug-Fix Rules

- Do not hide real Tauri runtime errors behind mock fallback. Browser-only fallback is acceptable only when the Tauri runtime is absent.
- Do not add a parallel state model. Extend `workspaceReducer`, `useWorkspaceController`, and the existing gateway boundary unless the task is an approved refactor.
- Do not change destructive file-operation behavior without explicit tests for source, destination, conflicts, symlinks, and refresh paths.
- Treat Chinese mojibake as a real bug. Preserve UTF-8 text and avoid adding new garbled strings.
- Prefer user-visible behavior tests over implementation tests for React components.

## Final Check

Report the root cause, changed files, and exact validation results. If Rust validation cannot run because `cargo` is missing, say that explicitly.
