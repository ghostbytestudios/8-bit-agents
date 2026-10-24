import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PlaneGeometry,
  SRGBColorSpace,
  type Material,
} from 'three';
import type { PropKind } from './layout';

/** A built prop; `update` is called every frame for props that animate (server LEDs). */
export interface Prop {
  object: Group;
  update?: (time: number) => void;
}

type Vec3 = [number, number, number];

const lambert = new Map<string, MeshLambertMaterial>();
function shaded(color: string): MeshLambertMaterial {
  let shared = lambert.get(color);
  if (!shared) {
    shared = new MeshLambertMaterial({ color: new Color(color) });
    lambert.set(color, shared);
  }
  return shared;
}

function part(group: Group, size: Vec3, material: Material, position: Vec3): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function pixelTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable for prop texture');
  draw(context);
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Wall-mounted board: frame + textured face. Faces +z, centered on its origin. */
function wallBoard(size: [number, number], frameColor: string, face: CanvasTexture): Group {
  const board = new Group();
  part(board, [size[0], size[1], 0.04], shaded(frameColor), [0, 0, 0]);
  const surface = new Mesh(new PlaneGeometry(size[0] - 0.1, size[1] - 0.08), new MeshLambertMaterial({ map: face }));
  surface.position.z = 0.021;
  surface.receiveShadow = true;
  board.add(surface);
  return board;
}

/** The Architect's board: a small hand-drawn architecture diagram. */
function whiteboard(): Prop {
  const face = pixelTexture(56, 34, (context) => {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 56, 34);
    const boxes: Array<[number, number, string]> = [[4, 4, '#0099db'], [22, 4, '#e43b44'], [40, 4, '#63c74d'], [22, 22, '#feae34']];
    for (const [x, y, color] of boxes) {
      context.strokeStyle = color;
      context.strokeRect(x + 0.5, y + 0.5, 12, 8);
    }
    context.strokeStyle = '#262b44';
    context.beginPath();
    context.moveTo(16, 8.5); context.lineTo(22, 8.5);
    context.moveTo(34, 8.5); context.lineTo(40, 8.5);
    context.moveTo(28.5, 12); context.lineTo(28.5, 22);
    context.stroke();
  });
  const object = wallBoard([1.5, 0.9], '#8b9bb4', face);
  part(object, [1.2, 0.03, 0.08], shaded('#5a6988'), [0, -0.46, 0.04]);
  return { object };
}

/** Task board: sticky notes on cork (becomes the live kanban later). */
function corkboard(): Prop {
  const face = pixelTexture(36, 24, (context) => {
    context.fillStyle = '#c28569';
    context.fillRect(0, 0, 36, 24);
    const notes: Array<[number, number, string]> = [
      [3, 3, '#fee761'], [10, 4, '#f6757a'], [3, 12, '#2ce8f5'], [17, 3, '#fee761'],
      [24, 5, '#63c74d'], [16, 13, '#fee761'], [26, 14, '#f6757a'], [9, 15, '#63c74d'],
    ];
    for (const [x, y, color] of notes) {
      context.fillStyle = color;
      context.fillRect(x, y, 5, 5);
      context.fillStyle = '#e43b44';
      context.fillRect(x + 2, y, 1, 1);
    }
  });
  return { object: wallBoard([1.1, 0.75], '#733e39', face) };
}

const LED_COLORS = ['#63c74d', '#63c74d', '#feae34', '#2ce8f5'];
const LED_OFF = new MeshBasicMaterial({ color: new Color('#181425') });
const LED_ON = LED_COLORS.map((color) => new MeshBasicMaterial({ color: new Color(color) }));
const LEDS_PER_RACK = 6;

/** Cheap deterministic hash in [0, 1). */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Server rack with drive slots and blinking status LEDs. Front faces +z. */
function serverRack(seed: number): Prop {
  const object = new Group();
  const height = 1.1;
  part(object, [0.58, height, 0.5], shaded('#262b44'), [0, height / 2, 0]);
  for (let slot = 0; slot < 5; slot++) {
    part(object, [0.48, 0.03, 0.01], shaded('#181425'), [0, 0.2 + slot * 0.18, 0.252]);
  }
  const leds = Array.from({ length: LEDS_PER_RACK }, (_, i) =>
    part(object, [0.035, 0.035, 0.01], LED_OFF, [0.18 - (i % 2) * 0.06, 0.25 + Math.floor(i / 2) * 0.27, 0.256]),
  );
  const rates = leds.map((_, i) => 1.5 + hash(seed * 7 + i) * 5);
  const update = (time: number) => {
    leds.forEach((led, i) => {
      const tick = Math.floor(time * rates[i]);
      const isOn = hash(seed * 31 + i * 17 + tick) > 0.35;
      led.material = isOn ? LED_ON[(seed + i) % LED_ON.length] : LED_OFF;
    });
  };
  return { object, update };
}

/** Three-drawer filing cabinet. Front faces +z. */
function filingCabinet(): Prop {
  const object = new Group();
  const height = 0.75;
  part(object, [0.42, height, 0.45], shaded('#8b9bb4'), [0, height / 2, 0]);
  for (let drawer = 0; drawer < 3; drawer++) {
    const y = 0.13 + drawer * 0.24;
    part(object, [0.38, 0.012, 0.005], shaded('#5a6988'), [0, y + 0.11, 0.226]);
    part(object, [0.1, 0.025, 0.02], shaded('#c0cbdc'), [0, y, 0.23]);
  }
  return { object };
}

/** Office printer on a stand, paper tray sticking out the front (+z). */
function printer(): Prop {
  const object = new Group();
  part(object, [0.6, 0.35, 0.45], shaded('#3a4466'), [0, 0.175, 0]);
  part(object, [0.55, 0.18, 0.42], shaded('#c0cbdc'), [0, 0.44, 0]);
  part(object, [0.3, 0.02, 0.15], shaded('#ffffff'), [0, 0.5, 0.26]);
  part(object, [0.1, 0.04, 0.01], new MeshBasicMaterial({ color: new Color('#2ce8f5') }), [0.17, 0.47, 0.211]);
  return { object };
}

/** The inbox on your desk — where agents' questions will land. */
function inboxTray(): Prop {
  const object = new Group();
  const tray = shaded('#feae34');
  part(object, [0.22, 0.012, 0.16], tray, [0, 0.006, 0]);
  part(object, [0.22, 0.04, 0.012], tray, [0, 0.02, -0.074]);
  part(object, [0.012, 0.04, 0.16], tray, [-0.104, 0.02, 0]);
  part(object, [0.012, 0.04, 0.16], tray, [0.104, 0.02, 0]);
  part(object, [0.17, 0.02, 0.12], shaded('#ffffff'), [0, 0.022, 0]);
  return { object };
}

export function createProp(kind: PropKind, seed: number): Prop {
  switch (kind) {
    case 'whiteboard': return whiteboard();
    case 'corkboard': return corkboard();
    case 'serverRack': return serverRack(seed);
    case 'filingCabinet': return filingCabinet();
    case 'printer': return printer();
    case 'inboxTray': return inboxTray();
  }
}
