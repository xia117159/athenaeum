---
name: sfm-windows-desktop-visual-design
description: Improve SimpleFileManager visual design for a Windows desktop file manager. Use when Codex changes workspace CSS, visual hierarchy, density, colors, typography, Windows 11 or Fluent-like styling, panel chrome, command bars, tabs, file lists, directory trees, settings panes, status bars, hover/selection/focus states, or when screenshots show the UI looks too web-like, cluttered, ugly, low contrast, or inconsistent with desktop file manager expectations.
---

# SFM Windows Desktop Visual Design

## Workflow

1. Use this skill together with `sfm-react-workspace-ui` for implementation and `sfm-architecture-guard` for broad UI refactors.
2. Inspect the current UI surface before editing:
   - `src/features/workspace/workspace.css`
   - `src/features/workspace/WorkspaceView.tsx`
   - `src/features/workspace/WorkspacePanelChrome.tsx`
   - `src/features/workspace/FileListing.tsx`
   - `src/features/workspace/WorkspaceTreeBranch.tsx`
   - settings and context-menu components when relevant.
3. Identify visual root causes before changing code: unclear hierarchy, too many borders, browser-default controls, weak spacing, inconsistent states, poor contrast, cramped text, card nesting, or mock-looking data labels.
4. Make the smallest coherent visual slice first. Prefer CSS and class structure changes before behavior changes.
5. Preserve existing state, reducer, controller, and gateway boundaries. Components render view models and emit intents; do not add a parallel UI state model for visual-only work.
6. Add or update focused component/CSS tests when class names, layout contracts, density, row height, selection behavior, context menus, or settings structure change.
7. Run `npm test` and `npm run build`. Run Rust checks only when backend contracts or commands change.

## Visual Direction

- Make the app feel like a focused Windows 11 desktop utility, not a web admin dashboard.
- Use a high-density file-manager layout: compact command bars, stable panes, readable rows, and predictable keyboard-friendly surfaces.
- Prefer restrained Fluent-like cues: subtle surfaces, clear focus rings, low-contrast dividers, crisp typography, and stateful hover/selection backgrounds.
- Keep the first screen as the actual file manager. Do not add landing-page, hero, marketing, decorative, or explanatory sections.
- Keep cards rare. Use framed panels only for actual repeated items, modals, or tool surfaces. Do not put cards inside cards.
- Avoid decorative gradients, blobs, bokeh, or one-note palettes. Backgrounds should be quiet desktop surfaces.

## Workspace Shell

- Structure the top area as desktop chrome:
  - app title/menu row
  - command/address row
  - optional status/notification row.
- Reduce visual noise by using fewer hard borders. Use separators, hairlines, and surface contrast only where they clarify scan paths.
- Make toolbar buttons consistent in height, padding, border radius, typography, hover, active, disabled, and focus states.
- Preserve text fit at desktop and narrower widths. Do not let toolbar labels or paths overlap.

## Panels And Tabs

- Make active panel focus obvious without shouting: use a single accent edge, subtle tinted header, or focus ring, not multiple nested blue borders.
- Keep tabs compact and stable. The active tab should be clear; inactive tabs should recede.
- Avoid large rounded pills for ordinary desktop tabs unless the local design already uses them consistently.
- Ensure split panes have stable min sizes and no content-driven layout shift.

## File Listing

- Details view should read like a desktop file list:
  - aligned columns
  - compact row height
  - clear selected, hover, focused, and drop-target states
  - low-noise grid lines or separators.
- Icon, list, tiles, and content modes should share selection and hover language.
- File type badges/tags should not dominate filenames. Keep tags smaller and quieter than primary content.
- Use resolved system icons when available. Do not replace familiar file-manager iconography with decorative symbols.

## Directory Tree

- Treat the tree as navigation, not a card list.
- Use indentation, chevrons, icon alignment, and selected-path state to clarify hierarchy.
- Avoid oversized row backgrounds. Selected tree rows should be readable but less visually dominant than active file selections.
- Keep expand/collapse hit targets reliable while preserving compact density.

## Settings Pane

- Make settings look like a desktop properties/preferences pane:
  - compact section navigation
  - aligned labels and inputs
  - predictable grouped fields
  - restrained separators.
- Avoid stacking large cards for every setting. Use rows or groups unless a setting truly needs a contained editor.
- Inputs should not look like browser defaults. Normalize height, border, focus, disabled, and text alignment.

## Color And Typography

- Use system-style fonts already available in the app stack; prefer `Segoe UI`, `Inter`, or the existing project font fallback.
- Use small but legible desktop sizes. Do not scale font size with viewport width.
- Use accent color sparingly for active state, focus, primary actions, and selected navigation.
- Maintain WCAG-readable contrast for foreground text, muted text, borders, disabled controls, and selection states.
- Avoid dominant purple, beige, dark-blue/slate, brown/orange, and single-hue themes unless explicitly requested.

## Validation Checklist

- The screenshot or target surface no longer reads as browser-default controls.
- Visual hierarchy is clear in one scan: chrome, navigation tree, active panels, listing rows, settings pane, status bar.
- Text fits in toolbar buttons, tabs, tree rows, file rows, badges, and settings controls.
- Active, hover, selected, focused, disabled, loading, and empty states remain coherent.
- No nested cards, decorative backgrounds, layout shifts, or overlapping UI elements were introduced.
- `npm test` and `npm run build` pass, or exact blockers are reported.
