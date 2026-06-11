---
name: sfm-rust-fs-ops
description: Implement or fix SimpleFileManager local and remote filesystem operations in Rust. Use for browsing, copy, move, delete, rename, create-directory, search, icon resolution, FTP/SFTP behavior, path validation, conflict handling, recycle-bin behavior, and Windows shell integration.
---

# SFM Rust FS Ops

## Workflow

1. Read the affected command and service:
   - Commands: `src-tauri/src/commands/{workspace,operations,remote,search}.rs`
   - Services: `src-tauri/src/services/{fs_service,remote_service,search_service,windows_shell}.rs`
   - DTOs: `src-tauri/src/domain/models.rs`
2. Write or update a Rust unit test first. Use temp directories and deterministic assertions. Mark real network integration tests with `#[ignore]`.
3. Validate all path inputs before mutation:
   - Reject empty names, separators in entry names, `.` and `..` where unsafe.
   - Prevent moving/copying a directory into itself or its descendants.
   - Preserve existing conflict behavior with numbered suffixes.
   - Avoid following symlinks for recursive destructive operations unless explicitly designed and tested.
4. Prefer service functions returning `anyhow::Result<T>` and command wrappers returning `Result<T, String>`.
5. Keep long operations cancelable and progress-capable. Use task IDs/events for expensive copy, move, search, remote transfer, and icon extraction.
6. Use Windows-native behavior only behind Windows-specific service functions. Provide a safe non-Windows fallback for tests when practical.
7. Run Rust tests when `cargo` is available; otherwise run frontend tests/build and report the missing toolchain.

## Safety Rules

- Deletion should prefer recycle-bin behavior on Windows for local paths.
- Never delete destination conflicts to make an operation succeed.
- Never store remote passwords in JSON/TOML. Use Windows Credential Manager for persisted secrets.
- Keep remote roots constrained to the profile root; reject operations outside it.

## Output

Report the operation semantics, conflict strategy, and validation commands run.
