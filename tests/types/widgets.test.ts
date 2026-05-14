import { describe, expect, it } from 'vitest';
import {
  isWidgetMessage,
  type DiagramConfig,
  type GameConfig,
  type SimulationConfig,
  type Visualization3DConfig,
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

  it('accepts widget:simulation:result with full payload', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:simulation:result',
      payload: {
        variables: { angle: 45, velocity: 25 },
        activePresetName: 'Hit the target',
      },
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:simulation:result without optional activePresetName', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:simulation:result',
      payload: {
        variables: { angle: 30 },
      },
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:visualization3d:result with full payload', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:visualization3d:result',
      payload: {
        activeObjectId: 'earth',
        cameraState: {
          position: { x: 0, y: 0, z: 5 },
          target: { x: 0, y: 0, z: 0 },
          zoom: 1.5,
        },
        activePresetName: 'View Earth',
      },
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:visualization3d:result with empty payload (free orbit)', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:visualization3d:result',
      payload: {},
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:game:result with full payload', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:game:result',
      payload: {
        score: 250,
        achievements: ['first_blood', 'combo_x3'],
        currentQuestionIndex: 4,
        state: { lives: 2, level: 3, combo: 3 },
      },
    };
    expect(isWidgetMessage(msg)).toBe(true);
  });

  it('accepts widget:game:result with minimal payload (puzzle/card games)', () => {
    const msg: WidgetToPlayerMessage = {
      source: 'openmaic-widget',
      type: 'widget:game:result',
      payload: { score: 0 },
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

describe('SimulationConfig (Phase 7.3c)', () => {
  it('compiles as a valid WidgetConfig discriminant with full shape', () => {
    const cfg: WidgetConfig = {
      type: 'simulation',
      concept: 'projectile_motion',
      description: 'Tune launch angle and velocity to hit the target.',
      variables: [
        { name: 'angle', label: 'Launch Angle', min: 0, max: 90, default: 45, unit: '°' },
        { name: 'velocity', label: 'Initial Velocity', min: 0, max: 50, default: 20, unit: 'm/s', step: 0.5 },
      ],
      presets: [
        { name: 'Hit the target', variables: { angle: 30, velocity: 25 } },
        { name: 'Free fall', variables: { angle: 90, velocity: 0 } },
      ],
    };
    expect(cfg.type).toBe('simulation');
    if (cfg.type === 'simulation') {
      const sim = cfg as SimulationConfig;
      expect(sim.variables).toHaveLength(2);
      expect(sim.variables[0].unit).toBe('°');
      expect(sim.variables[1].step).toBe(0.5);
      expect(sim.presets?.[0].variables.angle).toBe(30);
    }
  });

  it('allows omitting optional fields (presets, teacherActions, unit, step)', () => {
    const minimal: SimulationConfig = {
      type: 'simulation',
      concept: 'pendulum',
      description: 'Simple pendulum.',
      variables: [{ name: 'length', label: 'Length', min: 0.1, max: 5, default: 1 }],
    };
    expect(minimal.presets).toBeUndefined();
    expect(minimal.teacherActions).toBeUndefined();
    expect(minimal.variables[0].unit).toBeUndefined();
    expect(minimal.variables[0].step).toBeUndefined();
  });
});

describe('Visualization3DConfig (Phase 7.3d)', () => {
  it('compiles as a valid WidgetConfig discriminant with full shape', () => {
    const cfg: WidgetConfig = {
      type: 'visualization3d',
      visualizationType: 'solar',
      description: 'Earth orbiting the Sun with the Moon attached.',
      objects: [
        {
          id: 'sun',
          type: 'sphere',
          name: 'Sun',
          position: { x: 0, y: 0, z: 0 },
          scale: 2,
          material: { type: 'emissive', color: '#ffaa00', emissive: '#ffaa00' },
        },
        {
          id: 'earth',
          type: 'sphere',
          name: 'Earth',
          position: { x: 5, y: 0, z: 0 },
          material: { type: 'phong', color: '#3366ff' },
          animation: { type: 'orbit', speed: 1, axis: 'y' },
          children: [
            {
              id: 'moon',
              type: 'sphere',
              position: { x: 1, y: 0, z: 0 },
              scale: 0.3,
              material: { type: 'lambert', color: '#cccccc' },
            },
          ],
        },
      ],
      interactions: [
        { type: 'orbit', target: 'camera', label: 'Orbit' },
        { type: 'button', target: 'sun', label: 'Focus Sun' },
        { type: 'slider', target: 'earth', param: 'speed', min: 0, max: 5, default: 1, step: 0.1 },
      ],
      camera: {
        position: { x: 0, y: 5, z: 10 },
        target: { x: 0, y: 0, z: 0 },
        fov: 60,
      },
      lighting: {
        ambient: { color: '#ffffff', intensity: 0.5 },
        directional: [
          { color: '#ffffff', intensity: 1.2, position: { x: 5, y: 10, z: 5 } },
        ],
        point: [
          { color: '#ffaa00', intensity: 1, position: { x: 0, y: 0, z: 0 } },
        ],
      },
      presets: [
        { name: 'View Earth', state: { cameraTarget: 'earth' } },
        { name: 'View Sun', description: 'Get up close', state: { cameraTarget: 'sun' } },
      ],
    };
    expect(cfg.type).toBe('visualization3d');
    if (cfg.type === 'visualization3d') {
      const v3d = cfg as Visualization3DConfig;
      expect(v3d.objects).toHaveLength(2);
      expect(v3d.objects[1].children?.[0].id).toBe('moon');
      expect(v3d.interactions?.[2].param).toBe('speed');
      expect(v3d.lighting?.directional?.[0].intensity).toBe(1.2);
      expect(v3d.presets?.[1].description).toBe('Get up close');
    }
  });

  it('allows omitting all optional fields (minimal config)', () => {
    const minimal: Visualization3DConfig = {
      type: 'visualization3d',
      visualizationType: 'geometry',
      description: 'A single cube.',
      objects: [{ id: 'cube', type: 'box' }],
    };
    expect(minimal.interactions).toBeUndefined();
    expect(minimal.camera).toBeUndefined();
    expect(minimal.lighting).toBeUndefined();
    expect(minimal.presets).toBeUndefined();
    expect(minimal.teacherActions).toBeUndefined();
    expect(minimal.objects[0].material).toBeUndefined();
    expect(minimal.objects[0].animation).toBeUndefined();
  });

  it('accepts numeric and per-axis scale, all material types, all animation types', () => {
    const cfg: Visualization3DConfig = {
      type: 'visualization3d',
      visualizationType: 'molecular',
      description: 'Hydrogen atom.',
      objects: [
        { id: 'a', type: 'sphere', scale: 0.5 },
        { id: 'b', type: 'cylinder', scale: { x: 1, y: 2, z: 1 } },
        { id: 'c', type: 'torus', material: { type: 'standard', wireframe: true } },
        { id: 'd', type: 'cone', material: { type: 'basic', transparent: true, opacity: 0.5 } },
        { id: 'e', type: 'plane', animation: { type: 'pulse', speed: 2 } },
        { id: 'f', type: 'custom', animation: { type: 'bounce' } },
      ],
    };
    expect(cfg.objects[0].scale).toBe(0.5);
    expect((cfg.objects[1].scale as { y: number }).y).toBe(2);
    expect(cfg.objects[2].material?.wireframe).toBe(true);
    expect(cfg.objects[4].animation?.type).toBe('pulse');
  });
});

describe('GameConfig (Phase 7.3e)', () => {
  it('compiles as a valid WidgetConfig discriminant — quiz with single+multiple questions', () => {
    const cfg: WidgetConfig = {
      type: 'game',
      gameType: 'quiz',
      description: 'Test your knowledge of physics fundamentals.',
      questions: [
        {
          id: 'q1',
          question: 'What is the SI unit of force?',
          type: 'single',
          options: ['Joule', 'Newton', 'Watt', 'Pascal'],
          correct: 1,
          explanation: 'Force is measured in newtons (N), where 1 N = 1 kg·m/s².',
          points: 10,
        },
        {
          id: 'q2',
          question: 'Which of these are vector quantities?',
          type: 'multiple',
          options: ['Velocity', 'Mass', 'Acceleration', 'Temperature'],
          correct: [0, 2],
          explanation: 'Vectors have direction; mass and temperature are scalars.',
        },
      ],
      scoring: {
        correctPoints: 10,
        speedBonus: 5,
        comboMultiplier: 1.5,
        penalty: 2,
      },
      achievements: [
        {
          id: 'perfect_run',
          name: 'Perfect Run',
          description: 'Answer all questions correctly without hints.',
          icon: 'trophy',
          condition: 'correctCount === total && hintsUsed === 0',
        },
      ],
    };
    expect(cfg.type).toBe('game');
    if (cfg.type === 'game') {
      const game = cfg as GameConfig;
      expect(game.gameType).toBe('quiz');
      expect(game.questions).toHaveLength(2);
      expect(game.questions?.[0].correct).toBe(1);
      expect(game.questions?.[1].correct).toEqual([0, 2]);
      expect(game.scoring.correctPoints).toBe(10);
      expect(game.scoring.comboMultiplier).toBe(1.5);
      expect(game.achievements?.[0].id).toBe('perfect_run');
    }
  });

  it('compiles for puzzle gameType without questions[] (drag-and-drop puzzles)', () => {
    const cfg: GameConfig = {
      type: 'game',
      gameType: 'puzzle',
      description: 'Sort the elements by atomic number.',
      scoring: { correctPoints: 5 },
    };
    expect(cfg.gameType).toBe('puzzle');
    expect(cfg.questions).toBeUndefined();
    expect(cfg.scoring.correctPoints).toBe(5);
    expect(cfg.scoring.speedBonus).toBeUndefined();
    expect(cfg.achievements).toBeUndefined();
    expect(cfg.teacherActions).toBeUndefined();
  });

  it('compiles minimal GameConfig (strategy / card)', () => {
    const strategy: GameConfig = {
      type: 'game',
      gameType: 'strategy',
      description: 'Resource allocation challenge.',
      scoring: { correctPoints: 1 },
    };
    const card: GameConfig = {
      type: 'game',
      gameType: 'card',
      description: 'Memory match: pair the concepts.',
      scoring: { correctPoints: 2 },
    };
    expect(strategy.gameType).toBe('strategy');
    expect(card.gameType).toBe('card');
  });

  it('rejects (compile-time) invalid gameType — guard via type assertion', () => {
    // This test documents the contract: only the four upstream gameType
    // values are accepted. We can't `expect` a TS compile error at runtime,
    // but we sanity-check the union narrows correctly.
    const cfg: GameConfig = {
      type: 'game',
      gameType: 'card',
      description: 'x',
      scoring: { correctPoints: 1 },
    };
    const allowed: Array<GameConfig['gameType']> = ['quiz', 'puzzle', 'strategy', 'card'];
    expect(allowed).toContain(cfg.gameType);
  });
});
