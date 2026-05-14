import { describe, expect, it } from 'vitest';
import {
  isWidgetMessage,
  type DiagramConfig,
  type WidgetConfig,
  type WidgetToPlayerMessage,
} from '@/lib/types/widgets';

describe('isWidgetMessage type guard', () => {
  it('accepts widget:ready', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:ready',
      widgetType: 'diagram',
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:diagram:result with full payload', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:diagram:result',
      payload: {
        revealedNodes: ['n1', 'n2'],
        currentStep: 1,
        focusedNodeId: 'n2',
      },
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:complete with no payload', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:complete',
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('rejects messages from other sources (player echo, hostile frame)', () => {
    expect(isWidgetMessage({ source: 'openmaic-player', type: 'widget:reset' })).toBe(false);
    expect(isWidgetMessage({ source: 'evil', type: 'widget:complete' })).toBe(false);
    expect(isWidgetMessage({ type: 'widget:complete' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isWidgetMessage(null)).toBe(false);
    expect(isWidgetMessage(undefined)).toBe(false);
    expect(isWidgetMessage('widget:complete')).toBe(false);
    expect(isWidgetMessage(42)).toBe(false);
  });
});

describe('DiagramConfig (Phase 7.3b)', () => {
  it('compiles as a valid WidgetConfig discriminant', () => {
    const cfg: WidgetConfig = {
      type: 'diagram',
      diagramType: 'flowchart',
      description: 'Lifecycle of a request',
      nodes: [
        { id: 'n1', label: 'Start', type: 'start' },
        { id: 'n2', label: 'Validate' },
        { id: 'n3', label: 'End', type: 'end' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3', label: 'ok' },
      ],
      revealOrder: ['n1', 'n2', 'n3'],
    };
    expect(cfg.type).toBe('diagram');
    // narrow with type guard then read diagram-specific field
    if (cfg.type === 'diagram') {
      const diagram = cfg as DiagramConfig;
      expect(diagram.nodes).toHaveLength(3);
      expect(diagram.edges[1].label).toBe('ok');
      expect(diagram.revealOrder?.[0]).toBe('n1');
    }
  });

  it('allows omitting optional fields (revealOrder, position, teacherActions)', () => {
    const minimal: DiagramConfig = {
      type: 'diagram',
      diagramType: 'mindmap',
      description: 'Topic map',
      nodes: [{ id: 'root', label: 'Root' }],
      edges: [],
    };
    expect(minimal.revealOrder).toBeUndefined();
    expect(minimal.teacherActions).toBeUndefined();
    expect(minimal.nodes[0].position).toBeUndefined();
  });
});
