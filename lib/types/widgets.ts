/**
 * Widget configuration types for Deep Interactive Mode.
 *
 * Phase 7.3a (Code widget) — baseline. Phase 7.3b adds DiagramConfig.
 * Each widget type sits behind its own per-widget feature flag
 * (`INTERACTIVE_WIDGET_*_ENABLED`); flag-off types fall back to the
 * legacy HTML-only sandbox path with no postMessage bridge attached.
 * Subsequent subphases (7.3c–e) will replace remaining stubs with full
 * configs.
 *
 * Adapted from upstream commit c02a607 ("feat: interactive mode clean
 * (#461)"). RU-fork keeps the same type names so future cherry-picks
 * for 7.3c–e can land with minimal renames.
 */

// ==================== Base Types ====================

export type WidgetType = 'code' | 'diagram' | 'simulation' | 'visualization3d' | 'game';

/**
 * TeacherAction — UI actions a tutor/agent can fire INSIDE a widget.
 *
 * Delivered to the widget iframe via postMessage from the player.
 * The widget's own runtime decides how to render `highlight`, `reveal`,
 * `setState`, etc. The transport layer is generic across all widget types.
 */
export interface TeacherAction {
  id: string;
  type: 'speech' | 'highlight' | 'annotation' | 'reveal' | 'setState';
  /** Element ID/CSS selector inside the widget DOM */
  target?: string;
  /** Speech text or annotation text */
  content?: string;
  /** Widget state to set (widget-defined shape) */
  state?: Record<string, unknown>;
  /** Short label for UI button (e.g., "Next", "Try this") */
  label?: string;
}

// ==================== Code Widget (Phase 7.3a) ====================

export interface CodeTestCase {
  id: string;
  input: string;
  expected: string;
  description?: string;
  isHidden?: boolean;
}

/**
 * CodeConfig — declarative spec for the `code` widget.
 *
 * The widget is rendered as a self-contained HTML+JS document inside a
 * sandboxed iframe (see `components/scene-renderers/interactive-renderer.tsx`).
 * Pyodide / Babel CDN scripts are loaded inside the iframe, NOT in the
 * parent. Test cases run inside the iframe and report results via
 * postMessage `{ type: 'widget:code:result', payload: { passed, ... } }`.
 *
 * Supported languages (per upstream prompt template):
 *   - python (Pyodide CDN)
 *   - javascript (native browser)
 *   - typescript (Babel CDN)
 *   - java/cpp accepted in schema but NOT executable yet — UI only.
 */
export interface CodeConfig {
  type: 'code';
  language: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  description: string;
  starterCode: string;
  testCases: CodeTestCase[];
  hints: string[];
  solution: string;
  teacherActions?: TeacherAction[];
}

// ==================== Diagram Widget (Phase 7.3b) ====================

/**
 * DiagramNode — a single node in an interactive diagram.
 *
 * The widget renders nodes as SVG shapes inside a sandboxed iframe (no
 * extra CDN — diagrams are self-contained SVG; see widget-sandbox.md).
 * `position` is optional — if omitted the widget runtime auto-layouts
 * (mind-map / hierarchy auto-arrange). `details` powers the click-to-
 * expand sidebar described in the upstream diagram-content prompt.
 */
export interface DiagramNode {
  id: string;
  label: string;
  position?: { x: number; y: number };
  details?: string;
  type?: 'default' | 'decision' | 'start' | 'end';
}

/** DiagramEdge — directed connection between two nodes by id. */
export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/**
 * DiagramConfig — declarative spec for the `diagram` widget.
 *
 * The widget is rendered as a self-contained HTML+SVG document inside a
 * sandboxed iframe (see `components/scene-renderers/interactive-renderer.tsx`).
 * Unlike the code widget, the diagram widget does NOT pull in any extra
 * CDN — SVG primitives + inline JS are all that's needed. Step-by-step
 * reveal animation is driven by `revealOrder`; if absent, the widget
 * reveals all nodes at once.
 *
 * Reports back to the player via:
 *   - `widget:diagram:result` { revealedNodes, currentStep }
 *   - `widget:state-change`   for arbitrary widget-internal state sync
 *   - `widget:complete`       when the user has stepped through to end
 */
export interface DiagramConfig {
  type: 'diagram';
  diagramType: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  description: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Node IDs in reveal sequence (step-by-step "Next/Prev" navigation). */
  revealOrder?: string[];
  teacherActions?: TeacherAction[];
}

// ==================== Stub configs for 7.3c–e ====================
// Type-only declarations so that the discriminated union compiles. The
// generation pipeline does NOT emit these in 7.3a/b — see subsequent
// subphases. Each will be replaced with the upstream definition when
// its widget lands.

export interface SimulationConfigStub {
  type: 'simulation';
  [key: string]: unknown;
}

export interface Visualization3DConfigStub {
  type: 'visualization3d';
  [key: string]: unknown;
}

export interface GameConfigStub {
  type: 'game';
  [key: string]: unknown;
}

/** Discriminated union over all widget configs. */
export type WidgetConfig =
  | CodeConfig
  | DiagramConfig
  | SimulationConfigStub
  | Visualization3DConfigStub
  | GameConfigStub;

// ==================== postMessage protocol ====================

/**
 * Messages sent FROM player TO widget iframe.
 * All carry the discriminator `source: 'openmaic-player'` so the widget
 * can ignore unrelated postMessage traffic.
 */
export type PlayerToWidgetMessage =
  | { source: 'openmaic-player'; type: 'widget:teacher-action'; action: TeacherAction }
  | { source: 'openmaic-player'; type: 'widget:set-state'; state: Record<string, unknown> }
  | { source: 'openmaic-player'; type: 'widget:reset' };

/**
 * Messages sent FROM widget iframe TO player.
 * The widget MUST set `source: 'openmaic-widget'` so the player can
 * filter out hostile messages that share the same window.parent target.
 */
export type WidgetToPlayerMessage =
  | { source: 'openmaic-widget'; type: 'widget:ready'; widgetType: WidgetType }
  | {
      source: 'openmaic-widget';
      type: 'widget:code:result';
      payload: { passed: number; total: number; testResults: Array<{ id: string; pass: boolean }> };
    }
  | {
      source: 'openmaic-widget';
      type: 'widget:diagram:result';
      payload: {
        /** IDs of nodes currently revealed (in order). */
        revealedNodes: string[];
        /** Index into `revealOrder` (0-based). */
        currentStep: number;
        /** Optional: id of the node the user just clicked. */
        focusedNodeId?: string;
      };
    }
  | { source: 'openmaic-widget'; type: 'widget:state-change'; state: Record<string, unknown> }
  | { source: 'openmaic-widget'; type: 'widget:complete'; payload?: Record<string, unknown> };

/** Type guard: did this MessageEvent come from a widget iframe we trust? */
export function isWidgetMessage(data: unknown): data is WidgetToPlayerMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === 'openmaic-widget'
  );
}
