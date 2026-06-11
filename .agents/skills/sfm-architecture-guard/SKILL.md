---
name: sfm-architecture-guard
description: Plan and execute SimpleFileManager architecture changes safely across Tauri v2, Rust services, React workspace state, TypeScript IPC, tests, and project skills. Use for refactors, module splits, contract cleanup, technical-debt reduction, large bug clusters, or any cross-module change.
---

# SFM Architecture Guard

## Workflow

1. Read the current repo instructions and architecture baseline:
   - `AGENTS.md`
   - `.temp/design.md` or `docs/design.md`
   - `package.json`
   - `src-tauri/Cargo.toml`
   - Active files under `src/features/workspace/*`
2. State a short plan with incremental validation points.
3. Choose a narrow first slice. Prefer extracting pure modules and adding contract tests before changing behavior.
4. Preserve module boundaries:
   - React components render and emit UI intents.
   - `useWorkspaceController` orchestrates effects and gateway calls.
   - Reducer owns deterministic workspace state transitions.
   - Gateway and extracted helpers own IPC, mapping, remote URI planning, and session persistence.
   - Rust commands validate IPC input and delegate to services.
   - Rust services own filesystem, remote, search, settings, and shell behavior.
5. Keep each slice buildable and testable. Avoid broad rewrites that leave the app between architectures.
6. Run validations after every substantial slice:
   - `npm test`
   - `npm run build`
   - `cargo check --manifest-path src-tauri/Cargo.toml --offline` when `cargo` is available
   - `cargo test --manifest-path src-tauri/Cargo.toml --offline` when `cargo` is available

## Refactor Priorities

Use this order unless the user asks otherwise:

1. Stabilize tests and contracts.
2. Split oversized pure TypeScript helpers from `workspaceGateway.ts`.
3. Remove production mock fallback from real Tauri command failures.
4. Introduce task/progress/cancel boundaries for long operations.
5. Normalize DTO naming and encoding.
6. Tighten Tauri capabilities and CSP after functional paths are stable.

## Guardrails

- Do not bypass existing workspace paths unless explicitly deprecating them.
- Do not combine unrelated UI redesign, IPC migration, and Rust operation changes in one untestable patch.
- Do not run `npm run dev` as routine validation.
- If `cargo` is unavailable, continue with TypeScript validation and report the exact blocker.

## Output

Summarize the slice completed, files moved or extracted, behavior intentionally unchanged, and validation results.
