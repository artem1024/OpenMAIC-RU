/**
 * Widget configuration types for Deep Interactive Mode.
 *
 * Phase 7.3a (Code widget) — baseline: only the `code` widget type is
 * supported behind the `INTERACTIVE_WIDGET_CODE_ENABLED` feature flag.
 * Other widget types (diagram, simulation, visualization3d, game) are
 * declared here for typed forward-compat but are NOT executable yet —
 * they are gated by their own per-widget flags in subsequent subphases
 * (7.3b–e). Generation paths that emit them are not yet wired in this
 * subphase.
 *
 * Adapted from upstream commit c02a607 ("feat: interactive mode clean
 * (#461)"). RU-fork keeps the same type names so future cherry-picks
 * for 7.3b–e can land with minimal renames.
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

// ==================== Stub configs for 7.3b–e ====================
// Type-only declarations so that the discriminated union compiles. The
// generation pipeline does NOT emit these in 7.3a — see subsequent
// subphases. Each will be replaced with the upstream definition when
// its widget lands.

export interface DiagramConfigStub {
  type: 'diagram';
  [key: string]: unknown;
}

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
  | DiagramConfigStub
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
