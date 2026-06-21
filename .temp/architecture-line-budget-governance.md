# Source Line Budget Governance

Date: 2026-06-22

## Purpose

This document records the fourth-stage architecture guardrail for oversized source files. The check is implemented by `scripts/source-line-budget.mjs` and is intended to prevent already-large files from growing silently while the remaining decomposition work continues.

## Budget Policy

The script uses two thresholds:

- `target`: crossing this threshold is reported as a warning and should be treated as a refactoring candidate.
- `max`: crossing this threshold fails the check unless the file is listed in `.temp/source-line-budget-exceptions.json`.

Current thresholds:

| Category | Target | Max |
| --- | ---: | ---: |
| React component | 500 | 800 |
| Hook/controller | 600 | 1000 |
| Reducer/state module | 800 | 1200 |
| Rust service module | 1000 | 1500 |
| Rust domain/contract module | 800 | 1200 |
| CSS module | 800 | 1200 |
| Test file | 1000 | 1800 |
| Build/test script | 400 | 800 |
| General TypeScript module | 800 | 1200 |

## Exception Rule

Exceptions are not blanket approvals. Each exception has a frozen `maxLines` value equal to the current file size at the time of registration. If a file grows beyond that number, the check fails and the change must either reduce the file or explicitly update the exception with a reason.

The current exception list is stored in `.temp/source-line-budget-exceptions.json`.

## Remaining Governance Order

1. Split `useWorkspaceController.ts` and `useWorkspaceController.test.ts` by navigation, operations, search, properties, remote trust, and settings persistence behavior.
2. Split `workspaceReducer.ts` and `workspaceReducer.test.ts` by action families while preserving the public reducer facade.
3. Continue Rust service decomposition:
   - `remote_service.rs`: move FTP and SFTP adapters into protocol modules.
   - `operation_service.rs`: extract conflict handling, undo execution, and task executor modules.
   - `windows_shell.rs`: split context menu, clipboard, drag/drop, file operation, navigation, and integrity modules.
4. Split large React surfaces:
   - `FileListing.tsx`
   - `SettingsSurface.tsx`
   - `WorkspaceView.tsx`
5. Continue DTO modularization from `domain/models.rs` for operation, search, shell, settings, and workspace contracts.

## Validation

Run:

```powershell
npm run check:source-lines
```

The full frontend test runner also executes `scripts/source-line-budget.test.mjs`, including a real repository check against the registered exceptions.
