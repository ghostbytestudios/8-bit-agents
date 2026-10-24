import { CanvasTexture, Mesh, MeshLambertMaterial, NearestFilter, PlaneGeometry, SRGBColorSpace } from 'three';
import type { FloorStyle, RoomDef } from './layout';

/** Floor texture resolution; one floor tile is 8×8 texels. */
const TEXELS = 8;

type TilePainter = (context: CanvasRenderingContext2D, x: number, z: number) => void;

function checker(even: string, odd: string): TilePainter {
  return (context, x, z) => {
    context.fillStyle = (x + z) % 2 === 0 ? even : odd;
    context.fillRect(x * TEXELS, z * TEXELS, TEXELS, TEXELS);
  };
}

/** Staggered planks, 2 texels tall, with a dark seam that shifts every row. */
const wood: TilePainter = (context, x, z) => {
  const planksPerTile = TEXELS / 2;
  for (let row = 0; row < planksPerTile; row++) {
    const plank = z * planksPerTile + row;
    context.fillStyle = plank % 2 === 0 ? '#b86f50' : '#a8644a';
    context.fillRect(x * TEXELS, z * TEXELS + row * 2, TEXELS, 2);
    context.fillStyle = '#733e39';
    context.fillRect(x * TEXELS + ((plank * 3 + x * 5) % TEXELS), z * TEXELS + row * 2, 1, 2);
  }
};

/** Raised-floor tiles with grout lines and a vent dot. */
const serverTile: TilePainter = (context, x, z) => {
  context.fillStyle = '#5a6988';
  context.fillRect(x * TEXELS, z * TEXELS, TEXELS, TEXELS);
  context.fillStyle = '#3a4466';
  context.fillRect(x * TEXELS, z * TEXELS, TEXELS, 1);
  context.fillRect(x * TEXELS, z * TEXELS, 1, TEXELS);
  context.fillStyle = '#4b5878';
  context.fillRect(x * TEXELS + 3, z * TEXELS + 3, 2, 2);
};

const PAINTERS: Record<FloorStyle, TilePainter> = {
  wood,
  serverTile,
  carpetBlue: checker('#3a4466', '#36405f'),
  carpetLight: checker('#8b9bb4', '#8394ae'),
  carpetWarm: checker('#733e39', '#6b3a35'),
  linoleum: checker('#c0cbdc', '#8b9bb4'),
  lobby: checker('#3e8948', '#3a8044'),
};

/** One plane for the whole office, textured per room. Later rooms paint over earlier ones. */
export function createFloor(rooms: readonly RoomDef[], width: number, depth: number): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = width * TEXELS;
  canvas.height = depth * TEXELS;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable for floor texture');

  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.rect;
    const paint = PAINTERS[room.floor];
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) paint(context, x, z);
  }

  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;

  const floor = new Mesh(new PlaneGeometry(width, depth), new MeshLambertMaterial({ map: texture }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(width / 2, 0, depth / 2);
  floor.receiveShadow = true;
  floor.name = 'floor';
  return floor;
}
