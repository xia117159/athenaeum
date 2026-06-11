---
name: sfm-tauri-ipc-contract
description: Maintain and evolve SimpleFileManager Tauri IPC contracts between Rust commands/events and TypeScript callers. Use when adding, renaming, or changing Tauri commands, invoke arguments, events, DTOs, capabilities, Rust domain models, or TypeScript backend types.
---

# SFM Tauri IPC Contract

## Workflow

1. Locate both sides of the contract:
   - Rust DTOs: `src-tauri/src/domain/models.rs`
   - Rust commands: `src-tauri/src/commands/*`
   - Invoke/listen callers: `src/features/workspace/*Gateway*.ts`, `src/lib/tauri.ts`
   - TS backend types: `src/app/types.ts`
   - Capabilities: `src-tauri/capabilities/*.json`
2. Add or update a contract test before implementation. Prefer tests for mapper behavior, command planning, and required argument shape.
3. Keep names stable and serde-compatible. Confirm `camelCase`, `kebab-case`, enum variants, optional fields, and nullability match TypeScript.
4. Keep IPC thin:
   - Commands validate inputs and delegate to services.
   - Services own filesystem, search, remote, metadata, and settings behavior.
   - Frontend mappers convert backend DTOs to UI view models.
5. Use events or channels for long-running or streaming work. File operations, remote operations, icon loading, and search must not become UI-blocking command calls.
6. Update capabilities when adding plugin permissions or command exposure.
7. Run `npm test`, `npm run build`, and Rust checks/tests when available.

## Contract Rules

- Do not maintain two divergent meanings for the same field. For example, normalize `file/folder` versus `file/directory` at a single mapper boundary.
- Do not introduce command arguments as loose `Record<string, unknown>` unless the boundary is already generic and tested.
- Do not silently swallow Tauri errors in production runtime. Browser fallback is only for non-Tauri local browsing or tests.
- Use structured error messages that identify the failed command and user-relevant reason.

## Output

Summarize the command/event names changed, DTO fields changed, and the tests that guard the contract.
