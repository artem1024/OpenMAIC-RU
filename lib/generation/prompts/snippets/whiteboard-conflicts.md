# Whiteboard layout conflicts (Phase 5 / upstream PR #485)

> Snippet companion to the runtime conflict block emitted by
> `buildWhiteboardConflicts()` in
> `lib/orchestration/summarizers/whiteboard-conflicts.ts`. The conflict
> block is appended to the system prompt by `buildStateContext()` in
> `lib/orchestration/prompt-builder.ts` whenever the whiteboard contains
> elements with detectable geometric problems. This file documents the
> rules so that role-specific templates (teacher / assistant / student)
> can reference them with `{{> whiteboard-conflicts }}` once PR #485's
> full template refactor is ported (Phase 5 follow-up).

## Layout rules / Правила компоновки доски

The whiteboard canvas is **1000 × 563 px**. All coordinates `(left, top,
width, height)` are pixel values inside that canvas. When you place
elements:

- Не выводи их за пределы холста (1000×563). Anything past the edge
  will be clipped from the student's view.
- Не накладывай элементы друг на друга. If two elements share more than
  ~30% of the smaller one's area, the runtime detector flags an
  `OVERLAP` conflict — students will see one element on top of the other
  and lose the underlying content.
- Не проводи стрелки/линии сквозь текст, формулы, таблицы или фигуры.
  The detector flags a `LINE CROSSES` conflict when a line segment cuts
  through a non-line element's bounding box.

## How conflicts surface in the prompt

When conflicts exist, the system prompt receives a block titled
**"Layout Conflicts Detected"** listing each issue. Each entry is a real
visible problem on the **current** board — not a guideline, not a
hypothetical. You MUST address them before adding new content:

- Use `wb_delete <id>` to remove one of the conflicting elements, OR
- Use `wb_clear` to reset the board and start fresh.

If the block is **absent**, the board is geometrically clean — do NOT
self-trigger `wb_clear` "just in case". An empty conflict list is a
positive signal.

## Detection thresholds (for reference)

| Rule              | Threshold / parameter                                  |
| ----------------- | ------------------------------------------------------ |
| Bbox overlap      | intersection ÷ min(area_A, area_B) ≥ 0.3 (30%)         |
| Line crosses bbox | proper segment-segment crossing OR endpoint inside box |
| Out of canvas     | any of x<0, y<0, x+w>1000, y+h>563                     |

Detection runs on the raw whiteboard JSON (no rasterization), so it is
fast and deterministic. Disable globally with the env flag
`WHITEBOARD_CONFLICT_DETECTION=false` (default: enabled).
