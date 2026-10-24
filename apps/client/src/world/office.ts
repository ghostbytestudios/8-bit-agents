import { Color, DirectionalLight, Group, HemisphereLight, type Mesh } from 'three';
import { loadModel } from './assets';
import { createFloor } from './floor';
import { FURNITURE, OFFICE_DEPTH, OFFICE_WIDTH, PROPS, ROOMS, SPOTS, WALLS, type Placement, type SpotDef } from './layout';
import { BOOKCASE_SHELVES, createBookRows, createProp, type Prop } from './props';
import { WalkGrid } from './walkGrid';
import { blockWalls, buildWalls } from './walls';

const SHADOW_MAP_SIZE = 2048;

export interface Office {
  group: Group;
  grid: WalkGrid;
  spots: ReadonlyMap<string, SpotDef>;
  /** Animates props such as server LEDs. */
  update(time: number): void;
}

function createLights(): Group {
  const lights = new Group();
  lights.add(new HemisphereLight(new Color('#ead4aa'), new Color('#262b44'), 1.6));
  const sun = new DirectionalLight(new Color('#fff1d6'), 2.4);
  sun.position.set(OFFICE_WIDTH * 0.75, 14, OFFICE_DEPTH * 1.05);
  sun.target.position.set(OFFICE_WIDTH / 2, 0, OFFICE_DEPTH / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0015;
  const extent = Math.max(OFFICE_WIDTH, OFFICE_DEPTH) * 0.75;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 50 });
  lights.add(sun, sun.target);
  return lights;
}

async function placeModel(placement: Placement): Promise<Group> {
  const model = await loadModel(placement.model);
  model.position.set(placement.at[0], placement.y ?? 0, placement.at[1]);
  model.rotation.y = placement.rotation ?? 0;
  model.scale.setScalar(placement.scale ?? 1);
  const wrapper = new Group();
  wrapper.add(model);
  return wrapper;
}

/** Every bookcase in the layout gets its shelves filled, in the bookcase's own frame. */
function fillBookcases(): Mesh[] {
  return FURNITURE.flatMap((placement, index) => {
    const spec = BOOKCASE_SHELVES[placement.model];
    if (!spec) return [];
    const rows = createBookRows(spec, index + 1);
    rows.position.set(placement.at[0], placement.y ?? 0, placement.at[1]);
    rows.rotation.y = placement.rotation ?? 0;
    rows.scale.setScalar(placement.scale ?? 1);
    return [rows];
  });
}

function buildGrid(): WalkGrid {
  const grid = new WalkGrid(OFFICE_WIDTH, OFFICE_DEPTH);
  blockWalls(grid, WALLS);
  for (const item of [...FURNITURE, ...PROPS]) {
    for (const [x, z] of item.blocks ?? []) grid.block(x, z);
  }
  return grid;
}

export async function buildOffice(): Promise<Office> {
  const group = new Group();
  group.add(createFloor(ROOMS, OFFICE_WIDTH, OFFICE_DEPTH), createLights());

  const props: Prop[] = PROPS.map((placement, index) => {
    const prop = createProp(placement.prop, index);
    prop.object.position.set(placement.at[0], placement.y ?? 0, placement.at[1]);
    prop.object.rotation.y = placement.rotation ?? 0;
    group.add(prop.object);
    return prop;
  });

  const [walls, ...furniture] = await Promise.all([buildWalls(WALLS), ...FURNITURE.map(placeModel)]);
  group.add(walls, ...furniture, ...fillBookcases());

  const animated = props.filter((prop) => prop.update);
  return {
    group,
    grid: buildGrid(),
    spots: new Map(SPOTS.map((spot) => [spot.id, spot])),
    update: (time) => animated.forEach((prop) => prop.update?.(time)),
  };
}
