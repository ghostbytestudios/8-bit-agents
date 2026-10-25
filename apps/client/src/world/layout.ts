import type { CharacterPose } from '../actors/character';
import type { Tile } from './walkGrid';

/**
 * The office floor plan, as data. Matches the GAME_PLAN mockup:
 *
 *   ┌ Boss ────┬ War room ──┬ Server ──┐
 *   │          │(whiteboard)│          │
 *   ├── door ──┴─── door ───┤──door────┤
 *   │ cubicle farm [cabinets]│ Library  │
 *   │                        ├──door────┤
 *   │ [printer]  [your desk] │ Break rm │
 *   └──── front door ────────┴──────────┘
 *
 * One unit = one floor tile. Walls run along grid lines between tiles.
 */
export const OFFICE_WIDTH = 23;
export const OFFICE_DEPTH = 15;
/** Workers walk in from just outside the front door. */
export const FRONT_DOOR_OUTSIDE = { x: 7.5, z: OFFICE_DEPTH + 0.8 } as const;

const DESK_HEIGHT = 0.384;
const COUNTER_HEIGHT = 0.45;
const BAR_HEIGHT = 0.42;
const BOOKCASE_TOP = 0.79;
const STOOL_SEAT_HEIGHT = 0.38;
const TV_STAND_HEIGHT = 0.31;
const SEAT_HEIGHT = 0.22;
const SOFA_SEAT_HEIGHT = 0.2;

/** Character headings: facing +z is 0. */
const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;
const FACE_EAST = Math.PI / 2;
const FACE_WEST = -Math.PI / 2;
/** Kenney models face +z at rotation 0; turned around they face north. */
const TURNED = Math.PI;

export type FloorStyle = 'wood' | 'carpetBlue' | 'carpetLight' | 'carpetWarm' | 'serverTile' | 'linoleum' | 'lobby';
export type WallStyle = 'tall' | 'low' | 'partition';
export type PropKind = 'whiteboard' | 'corkboard' | 'serverRack' | 'filingCabinet' | 'printer' | 'inboxTray';
/** 'visit' = where a colleague stands to talk to whoever owns `visit:<home spot id>`. */
export type SpotKind = 'boss' | 'whiteboard' | 'desk' | 'visit' | 'activity' | 'visitor' | 'entrance';

type Pair = readonly [number, number];

export interface RoomDef {
  id: string;
  label: string;
  rect: readonly [x0: number, z0: number, x1: number, z1: number];
  floor: FloorStyle;
}

export interface WallDef {
  /** 'x' runs along x on grid line z = line; 'z' runs along z on grid line x = line. */
  axis: 'x' | 'z';
  line: number;
  from: number;
  to: number;
  style: WallStyle;
  doors?: readonly Pair[];
  /** Tall walls only: tile indices that get a window piece. */
  windows?: readonly number[];
}

export interface Placement {
  model: string;
  at: Pair;
  y?: number;
  rotation?: number;
  scale?: number;
  blocks?: readonly Pair[];
}

export interface PropPlacement {
  prop: PropKind;
  at: Pair;
  y?: number;
  rotation?: number;
  blocks?: readonly Pair[];
}

export interface SpotDef {
  id: string;
  kind: SpotKind;
  /** Walkable tile the character paths to. */
  tile: Tile;
  /** Exact spot inside that tile where the character stops (e.g. the chair seat). */
  anchor: { x: number; z: number };
  heading: number;
  pose: CharacterPose;
  seatHeight: number;
}

function spot(
  id: string,
  kind: SpotKind,
  [x, z]: Pair,
  heading: number,
  pose: CharacterPose,
  options: { anchor?: Pair; seatHeight?: number } = {},
): SpotDef {
  const [ax, az] = options.anchor ?? [x + 0.5, z + 0.5];
  return { id, kind, tile: { x, z }, anchor: { x: ax, z: az }, heading, pose, seatHeight: options.seatHeight ?? 0 };
}

export const ROOMS: readonly RoomDef[] = [
  { id: 'boss', label: 'Boss Office', rect: [0, 0, 8, 6], floor: 'wood' },
  { id: 'war', label: 'War Room', rect: [8, 0, 15, 6], floor: 'carpetLight' },
  { id: 'server', label: 'Server Room', rect: [15, 0, 23, 6], floor: 'serverTile' },
  { id: 'library', label: 'Library', rect: [15, 6, 23, 10], floor: 'carpetWarm' },
  { id: 'break', label: 'Break Room', rect: [15, 10, 23, 15], floor: 'linoleum' },
  { id: 'farm', label: 'Cubicle Farm', rect: [0, 6, 15, 15], floor: 'carpetBlue' },
  // Painted after the farm so it overrides that corner.
  { id: 'lobby', label: 'Your Desk', rect: [10, 12, 15, 15], floor: 'lobby' },
];

// ── Cubicles: 2 rows × 4, each 2×2 tiles, open to the south ──────────────────

const CUBICLE_COLUMNS = [1, 4, 7, 10];
const CUBICLE_ROWS = [7, 10];

function cubicle(number: number, x0: number, z0: number) {
  const deskX = x0 + 0.5;
  const decoration: Placement = number % 2 === 0
    ? { model: 'plantSmall2', at: [x0 + 1.5, z0 + 0.2], y: 0.4 }
    : { model: 'books', at: [x0 + 1.45, z0 + 0.2], y: 0.4 };
  const furniture: Placement[] = [
    { model: 'desk', at: [deskX, z0 + 0.35], rotation: TURNED, blocks: [[x0, z0]] },
    { model: 'computerScreen', at: [deskX, z0 + 0.22], y: DESK_HEIGHT, rotation: TURNED },
    { model: 'computerKeyboard', at: [deskX, z0 + 0.5], y: DESK_HEIGHT, rotation: TURNED },
    { model: 'computerMouse', at: [deskX + 0.25, z0 + 0.5], y: DESK_HEIGHT, rotation: TURNED },
    { model: 'chairDesk', at: [deskX, z0 + 1.15], rotation: TURNED },
    { model: 'bookcaseOpenLow', at: [x0 + 1.5, z0 + 0.2], blocks: [[x0 + 1, z0]] },
    decoration,
  ];
  const walls: WallDef[] = [
    { axis: 'x', line: z0, from: x0, to: x0 + 2, style: 'partition' },
    { axis: 'z', line: x0, from: z0, to: z0 + 1.5, style: 'partition' },
    { axis: 'z', line: x0 + 2, from: z0, to: z0 + 1.5, style: 'partition' },
  ];
  const desk = spot(`desk:W${number}`, 'desk', [x0, z0 + 1], FACE_NORTH, 'type', {
    anchor: [deskX, z0 + 1.1],
    seatHeight: SEAT_HEIGHT,
  });
  // Just behind the chair, in the aisle.
  const visit = spot(`visit:desk:W${number}`, 'visit', [x0, z0 + 2], FACE_NORTH, 'idle', { anchor: [deskX, z0 + 2.2] });
  return { furniture, walls, spot: desk, visit };
}

const CUBICLES = CUBICLE_ROWS.flatMap((z0, row) =>
  CUBICLE_COLUMNS.map((x0, column) => cubicle(row * CUBICLE_COLUMNS.length + column + 1, x0, z0)),
);

// ── Walls ─────────────────────────────────────────────────────────────────────

export const WALLS: readonly WallDef[] = [
  // Exterior: back and left are behind everything, so they stay tall; front and right are cut away.
  { axis: 'x', line: 0, from: 0, to: OFFICE_WIDTH, style: 'tall', windows: [2, 5, 10, 13, 17, 20] },
  { axis: 'z', line: 0, from: 0, to: OFFICE_DEPTH, style: 'tall', windows: [2, 8, 9, 12] },
  { axis: 'x', line: OFFICE_DEPTH, from: 0, to: OFFICE_WIDTH, style: 'low', doors: [[7, 9]] },
  { axis: 'z', line: OFFICE_WIDTH, from: 0, to: OFFICE_DEPTH, style: 'low' },
  // Interior.
  { axis: 'x', line: 6, from: 0, to: 15, style: 'low', doors: [[3, 5], [11, 13]] },
  { axis: 'x', line: 6, from: 15, to: 23, style: 'low', doors: [[18, 20]] },
  { axis: 'x', line: 10, from: 15, to: 23, style: 'low', doors: [[18, 20]] },
  { axis: 'z', line: 8, from: 0, to: 6, style: 'low' },
  { axis: 'z', line: 15, from: 0, to: 15, style: 'low', doors: [[7, 9], [12, 14]] },
  ...CUBICLES.flatMap((c) => c.walls),
];

// ── Furniture (Kenney models) ─────────────────────────────────────────────────

const BOSS_OFFICE: Placement[] = [
  { model: 'rugRectangle', at: [3.5, 2.2] },
  { model: 'desk', at: [3.133, 1.7], rotation: TURNED, blocks: [[3, 1]] },
  { model: 'desk', at: [3.867, 1.7], rotation: TURNED, blocks: [[3, 1]] },
  { model: 'computerScreen', at: [3.5, 1.57], y: DESK_HEIGHT, rotation: TURNED },
  { model: 'computerKeyboard', at: [3.5, 1.85], y: DESK_HEIGHT, rotation: TURNED },
  { model: 'computerMouse', at: [3.8, 1.85], y: DESK_HEIGHT, rotation: TURNED },
  { model: 'books', at: [2.95, 1.6], y: DESK_HEIGHT },
  { model: 'chairDesk', at: [3.5, 2.45], rotation: TURNED },
  { model: 'bookcaseClosedWide', at: [0.9, 0.18], blocks: [[0, 0], [1, 0]] },
  { model: 'bookcaseClosedWide', at: [1.7, 0.18], blocks: [[1, 0]] },
  { model: 'bookcaseClosedWide', at: [5.5, 0.18], blocks: [[5, 0]] },
  { model: 'bookcaseClosedWide', at: [6.3, 0.18], blocks: [[6, 0]] },
  { model: 'pottedPlant', at: [7.5, 0.5], blocks: [[7, 0]] },
  { model: 'trashcan', at: [2.3, 1.5], blocks: [[2, 1]] },
  { model: 'loungeSofa', at: [0.3, 4.0], rotation: Math.PI / 2, blocks: [[0, 3], [0, 4]] },
  { model: 'tableCoffee', at: [1.2, 4.0], rotation: Math.PI / 2, blocks: [[1, 3], [1, 4]] },
  { model: 'lampSquareFloor', at: [0.4, 5.5], blocks: [[0, 5]] },
  { model: 'coatRackStanding', at: [7.5, 5.4], blocks: [[7, 5]] },
];

const SKILL_SHELF_ZS = [2.4, 2.8, 3.2];

const WAR_ROOM: Placement[] = [
  { model: 'table', at: [10.58, 3.6], blocks: [[10, 3]] },
  { model: 'table', at: [11.42, 3.6], blocks: [[11, 3]] },
  { model: 'chairDesk', at: [10.58, 2.95] },
  { model: 'chairDesk', at: [11.42, 2.95] },
  { model: 'chairDesk', at: [10.58, 4.25], rotation: TURNED },
  { model: 'chairDesk', at: [11.42, 4.25], rotation: TURNED },
  { model: 'laptop', at: [10.6, 3.55], y: 0.327, rotation: TURNED },
  { model: 'cabinetTelevision', at: [13.6, 0.2], blocks: [[13, 0]] },
  { model: 'televisionModern', at: [13.6, 0.18], y: TV_STAND_HEIGHT },
  { model: 'pottedPlant', at: [8.5, 0.5], blocks: [[8, 0]] },
  { model: 'pottedPlant', at: [14.5, 0.5], blocks: [[14, 0]] },
  // The skill shelf on the east wall (click it to edit skills; agents read them here).
  ...SKILL_SHELF_ZS.map((z): Placement => ({ model: 'bookcaseOpen', at: [14.78, z], rotation: -Math.PI / 2, blocks: [[14, Math.floor(z)]] })),
];

const SERVER_ROOM: Placement[] = [
  { model: 'cardboardBoxClosed', at: [22.5, 5.5], blocks: [[22, 5]] },
  { model: 'cardboardBoxClosed', at: [22.45, 5.5], y: 0.2, rotation: 0.5 },
  { model: 'cardboardBoxClosed', at: [21.6, 5.5], blocks: [[21, 5]] },
];

const LIBRARY: Placement[] = [
  ...[15.6, 16.4, 17.2, 20.8, 21.6, 22.4].map((x): Placement => ({
    model: 'bookcaseClosedWide',
    at: [x, 6.18],
    blocks: [[Math.floor(x - 0.39), 6], [Math.floor(x + 0.39), 6]],
  })),
  // Books and plants along the tops of the wall shelves.
  { model: 'books', at: [15.6, 6.15], y: BOOKCASE_TOP },
  { model: 'plantSmall3', at: [16.4, 6.15], y: BOOKCASE_TOP },
  { model: 'books', at: [17.25, 6.15], y: BOOKCASE_TOP, rotation: 0.3 },
  { model: 'books', at: [20.8, 6.15], y: BOOKCASE_TOP, rotation: -0.2 },
  { model: 'plantSmall1', at: [21.6, 6.15], y: BOOKCASE_TOP },
  { model: 'books', at: [22.4, 6.15], y: BOOKCASE_TOP },
  ...[18.2, 18.6, 19.0, 19.4, 19.8].map((x): Placement => ({ model: 'bookcaseOpen', at: [x, 8.3], blocks: [[Math.floor(x), 8]] })),
  { model: 'rugRectangle', at: [19.0, 9.35], scale: 0.8 },
  // Reading corners: the lounge chairs are seats (see library:read-* spots).
  { model: 'rugRound', at: [21.4, 9.3] },
  { model: 'loungeChair', at: [21.4, 9.6], rotation: TURNED },
  { model: 'loungeChair', at: [16.4, 9.6], rotation: TURNED },
  { model: 'sideTable', at: [17.3, 9.75], blocks: [[17, 9]] },
  { model: 'lampSquareTable', at: [17.15, 9.75], y: DESK_HEIGHT },
  { model: 'books', at: [17.45, 9.75], y: DESK_HEIGHT },
  { model: 'lampSquareFloor', at: [22.6, 9.5], blocks: [[22, 9]] },
  { model: 'bookcaseOpenLow', at: [22.85, 8.2], rotation: -Math.PI / 2, blocks: [[22, 8]] },
  { model: 'books', at: [22.85, 8.2], y: 0.4, rotation: -Math.PI / 2 },
  { model: 'pottedPlant', at: [22.6, 7.0], blocks: [[22, 7]] },
];

const BREAK_ROOM: Placement[] = [
  { model: 'kitchenFridge', at: [15.4, 10.2], blocks: [[15, 10]] },
  { model: 'kitchenCabinet', at: [15.86, 10.3], blocks: [[15, 10]] },
  { model: 'kitchenCabinet', at: [16.29, 10.3], blocks: [[16, 10]] },
  { model: 'kitchenCabinet', at: [16.72, 10.3], blocks: [[16, 10]] },
  { model: 'kitchenSink', at: [17.15, 10.3], blocks: [[17, 10]] },
  { model: 'kitchenMicrowave', at: [15.86, 10.25], y: COUNTER_HEIGHT },
  { model: 'kitchenCoffeeMachine', at: [16.29, 10.3], y: COUNTER_HEIGHT },
  { model: 'toaster', at: [16.72, 10.25], y: COUNTER_HEIGHT },
  { model: 'tableRound', at: [17.5, 12.6], blocks: [[17, 12]] },
  { model: 'chairDesk', at: [16.85, 12.6], rotation: Math.PI / 2 },
  { model: 'chairDesk', at: [18.15, 12.6], rotation: -Math.PI / 2 },
  // TV corner: sofa, lounge chair and a rug.
  { model: 'cabinetTelevision', at: [21.0, 10.2], blocks: [[20, 10], [21, 10]] },
  { model: 'televisionModern', at: [21.0, 10.18], y: TV_STAND_HEIGHT },
  { model: 'speaker', at: [22.0, 10.25], blocks: [[22, 10]] },
  { model: 'rugRectangle', at: [21.0, 14.0] },
  { model: 'tableCoffee', at: [21.0, 13.6], blocks: [[20, 13], [21, 13]] },
  { model: 'loungeSofa', at: [21.0, 14.6], rotation: TURNED },
  { model: 'loungeDesignChair', at: [19.7, 13.6], rotation: Math.PI / 2 },
  // Coffee bar along the right wall, stools facing it.
  ...[11.2, 11.63, 12.06, 12.49].map((z): Placement => ({ model: 'kitchenBar', at: [22.78, z], rotation: -Math.PI / 2 })),
  { model: 'radio', at: [22.78, 11.25], y: BAR_HEIGHT, rotation: -Math.PI / 2 },
  { model: 'kitchenBlender', at: [22.78, 12.3], y: BAR_HEIGHT },
  { model: 'stoolBar', at: [22.35, 11.45] },
  { model: 'stoolBar', at: [22.35, 12.4] },
  { model: 'trashcan', at: [22.6, 13.4], blocks: [[22, 13]] },
  { model: 'pottedPlant', at: [22.6, 14.5], blocks: [[22, 14]] },
  { model: 'pottedPlant', at: [15.4, 14.6], blocks: [[15, 14]] },
];

const FARM_AND_LOBBY: Placement[] = [
  { model: 'pottedPlant', at: [0.5, 6.5], blocks: [[0, 6]] },
  { model: 'trashcan', at: [2.5, 14.6], blocks: [[2, 14]] },
  { model: 'pottedPlant', at: [10.5, 14.5], blocks: [[10, 14]] },
  { model: 'pottedPlant', at: [14.5, 11.4], blocks: [[14, 11]] },
  // Your desk.
  { model: 'rugRectangle', at: [12.0, 13.5] },
  { model: 'desk', at: [12.0, 13.6], rotation: TURNED, blocks: [[11, 13], [12, 13]] },
  { model: 'laptop', at: [12.1, 13.6], y: DESK_HEIGHT, rotation: TURNED },
  { model: 'chairDesk', at: [12.0, 14.35], rotation: TURNED, blocks: [[12, 14]] },
  { model: 'lampSquareTable', at: [12.3, 13.45], y: DESK_HEIGHT },
];

export const FURNITURE: readonly Placement[] = [
  ...BOSS_OFFICE,
  ...WAR_ROOM,
  ...SERVER_ROOM,
  ...LIBRARY,
  ...BREAK_ROOM,
  ...FARM_AND_LOBBY,
  ...CUBICLES.flatMap((c) => c.furniture),
];

// ── Procedural props (no Kenney equivalent) ───────────────────────────────────

const RACK_XS = [16.35, 16.97, 17.59, 18.21, 19.79, 20.41, 21.03, 21.65];
const FRONT_CABINET_XS = [3, 4, 5];

export const PROPS: readonly PropPlacement[] = [
  { prop: 'whiteboard', at: [11.5, 0.04], y: 0.78 },
  { prop: 'corkboard', at: [9.6, 0.04], y: 0.75 },
  ...RACK_XS.map((x): PropPlacement => ({ prop: 'serverRack', at: [x, 0.4], blocks: [[Math.floor(x), 0]] })),
  ...RACK_XS.map((x): PropPlacement => ({ prop: 'serverRack', at: [x, 2.6], blocks: [[Math.floor(x), 2]] })),
  ...[13.5, 14.5].map((x): PropPlacement => ({ prop: 'filingCabinet', at: [x, 6.3], blocks: [[Math.floor(x), 6]] })),
  // Private cabinets so the Boss and Architect can read files without leaving.
  { prop: 'filingCabinet', at: [4.45, 0.3], blocks: [[4, 0]] },
  { prop: 'filingCabinet', at: [8.3, 2.5], rotation: Math.PI / 2, blocks: [[8, 2]] },
  // Overflow cabinets on the front wall, next to the printer, facing into the room.
  ...FRONT_CABINET_XS.map((x): PropPlacement => ({ prop: 'filingCabinet', at: [x + 0.5, 14.7], rotation: TURNED, blocks: [[x, 14]] })),
  { prop: 'printer', at: [1.5, 14.55], rotation: TURNED, blocks: [[1, 14]] },
  { prop: 'inboxTray', at: [11.7, 13.5], y: DESK_HEIGHT },
];

// ── Things you can click ──────────────────────────────────────────────────────

export type HotspotId = 'files' | 'skills';

export interface HotspotDef {
  id: HotspotId;
  /** Shown when the pointer is over it. */
  label: string;
  at: Pair;
  /** Top of the object; clicks anywhere between the floor and here count. */
  height: number;
}

/** Both in the War Room: the Architect's cabinet holds the workspace files, the shelf holds skills. */
export const HOTSPOTS: readonly HotspotDef[] = [
  { id: 'files', label: 'FILES', at: [8.3, 2.5], height: 0.75 },
  { id: 'skills', label: 'SKILLS', at: [14.78, 2.8], height: 0.85 },
];

// ── Named spots ───────────────────────────────────────────────────────────────

export const SPOTS: readonly SpotDef[] = [
  spot('boss', 'boss', [3, 2], FACE_NORTH, 'type', { anchor: [3.5, 2.4], seatHeight: SEAT_HEIGHT }),
  spot('whiteboard', 'whiteboard', [11, 0], FACE_NORTH, 'draw', { anchor: [11.95, 0.72] }),
  ...CUBICLES.map((c) => c.spot),
  ...CUBICLES.map((c) => c.visit),
  spot('visit:boss', 'visit', [4, 2], FACE_WEST, 'idle', { anchor: [4.35, 2.45] }),
  spot('visit:whiteboard', 'visit', [12, 1], FACE_WEST, 'idle', { anchor: [12.45, 1.05] }),

  spot('server:a', 'activity', [17, 1], FACE_NORTH, 'operate', { anchor: [17.3, 1.15] }),
  spot('server:b', 'activity', [20, 3], FACE_NORTH, 'operate', { anchor: [20.4, 3.2] }),
  spot('library:a', 'activity', [16, 7], FACE_NORTH, 'operate', { anchor: [16.4, 7.0] }),
  spot('library:b', 'activity', [21, 7], FACE_NORTH, 'operate', { anchor: [21.2, 7.0] }),
  spot('library:c', 'activity', [18, 9], FACE_NORTH, 'operate', { anchor: [18.6, 8.95] }),
  spot('library:read-a', 'activity', [16, 9], FACE_NORTH, 'sit', { anchor: [16.4, 9.55], seatHeight: SOFA_SEAT_HEIGHT }),
  spot('library:read-b', 'activity', [21, 9], FACE_NORTH, 'sit', { anchor: [21.4, 9.55], seatHeight: SOFA_SEAT_HEIGHT }),
  spot('cabinets:a', 'activity', [13, 7], FACE_NORTH, 'operate', { anchor: [13.5, 6.95] }),
  spot('cabinets:b', 'activity', [14, 7], FACE_NORTH, 'operate', { anchor: [14.5, 6.95] }),
  ...FRONT_CABINET_XS.map((x, i) =>
    spot(`cabinets:front-${i + 1}`, 'activity', [x, 13], FACE_SOUTH, 'operate', { anchor: [x + 0.5, 14.05] })),
  // `<place>@<home spot id>` = private to whoever lives at that home (see Choreographer).
  spot('cabinets@boss', 'activity', [4, 1], FACE_NORTH, 'operate', { anchor: [4.45, 0.95] }),
  spot('cabinets@whiteboard', 'activity', [9, 2], FACE_WEST, 'operate', { anchor: [8.95, 2.5] }),
  spot('skills:a', 'activity', [13, 2], FACE_EAST, 'operate', { anchor: [13.95, 2.6] }),
  spot('skills:b', 'activity', [13, 3], FACE_EAST, 'operate', { anchor: [13.95, 3.3] }),
  spot('printer', 'activity', [1, 13], FACE_SOUTH, 'operate', { anchor: [1.5, 13.95] }),
  spot('coffee', 'activity', [16, 11], FACE_NORTH, 'operate', { anchor: [16.29, 10.95] }),
  spot('meeting:a', 'activity', [10, 2], FACE_SOUTH, 'sit', { anchor: [10.58, 2.95], seatHeight: SEAT_HEIGHT }),
  spot('meeting:b', 'activity', [11, 2], FACE_SOUTH, 'sit', { anchor: [11.42, 2.95], seatHeight: SEAT_HEIGHT }),
  spot('meeting:c', 'activity', [10, 4], FACE_NORTH, 'sit', { anchor: [10.58, 4.25], seatHeight: SEAT_HEIGHT }),
  spot('meeting:d', 'activity', [11, 4], FACE_NORTH, 'sit', { anchor: [11.42, 4.25], seatHeight: SEAT_HEIGHT }),
  spot('break:a', 'activity', [16, 12], FACE_EAST, 'sit', { anchor: [16.85, 12.6], seatHeight: SEAT_HEIGHT }),
  spot('break:b', 'activity', [18, 12], FACE_WEST, 'sit', { anchor: [18.15, 12.6], seatHeight: SEAT_HEIGHT }),
  spot('sofa:a', 'activity', [20, 14], FACE_NORTH, 'sit', { anchor: [20.75, 14.55], seatHeight: SOFA_SEAT_HEIGHT }),
  spot('sofa:b', 'activity', [21, 14], FACE_NORTH, 'sit', { anchor: [21.25, 14.55], seatHeight: SOFA_SEAT_HEIGHT }),
  spot('sofa:c', 'activity', [19, 13], FACE_EAST, 'sit', { anchor: [19.75, 13.6], seatHeight: SOFA_SEAT_HEIGHT }),
  spot('break:bar-a', 'activity', [22, 11], FACE_EAST, 'sit', { anchor: [22.35, 11.45], seatHeight: STOOL_SEAT_HEIGHT }),
  spot('break:bar-b', 'activity', [22, 12], FACE_EAST, 'sit', { anchor: [22.35, 12.4], seatHeight: STOOL_SEAT_HEIGHT }),

  spot('visitor:a', 'visitor', [11, 12], FACE_SOUTH, 'idle', { anchor: [11.6, 12.4] }),
  spot('visitor:b', 'visitor', [12, 12], FACE_SOUTH, 'idle', { anchor: [12.4, 12.4] }),
  spot('entrance', 'entrance', [7, 14], FACE_NORTH, 'idle'),
];
