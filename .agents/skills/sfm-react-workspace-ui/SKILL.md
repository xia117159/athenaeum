---
name: sfm-react-workspace-ui
description: Build or fix SimpleFileManager React workspace UI within the existing high-density file-manager architecture. Use for workspace panels, tabs, tree, listing, search drawer, settings surfaces, context menus, keyboard shortcuts, drag/drop, icons, layout CSS, and state/reducer interactions.
---

# SFM React Workspace UI

## Workflow

1. Read the existing workspace path before editing:
   - `src/features/workspace/types.ts`
   - `src/features/workspace/workspaceReducer.ts`
   - `src/features/workspace/useWorkspaceController.ts`
   - Relevant component and CSS files under `src/features/workspace/`
2. Add or update a focused test first:
   - Reducer/state behavior: `workspaceReducer.test.ts` or `state.test.ts`
   - Hook orchestration: `useWorkspaceController.test.ts`
   - Component behavior/layout: component `*.test.tsx`
3. Preserve the current state model. Add actions/selectors to the reducer rather than creating component-local parallel state for workspace behavior.
4. Keep gateway calls at the controller/gateway boundary. Components should receive actions and view models, not call Tauri directly.
5. Design for high-density Windows desktop use:
   - Compact controls, stable dimensions, no marketing layout.
   - No nested cards or decorative gradients/orbs.
   - Text must fit in buttons, rows, tabs, and panels at desktop and narrow widths.
   - Use icon buttons for common tools when an icon already exists in the project.
6. Keep real Tauri IPC as the primary path. Mock data is only for browser fallback and tests.
7. Run `npm test` and `npm run build`.

## UI Rules

- Do not bypass `WorkspaceView`/controller state for panel, tab, selection, navigation, clipboard, search, or settings behavior.
- Do not let async navigation or search results commit to the wrong active tab; carry panel and tab identity through actions.
- For file listing changes, account for details mode and icon modes.
- For drag/drop and context menu changes, test selection preservation and Ctrl-copy behavior.

## Output

Report user-facing behavior changed, tests added, and build/test results.
