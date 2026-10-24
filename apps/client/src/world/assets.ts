import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_ROOT = '/assets/kenney-furniture';
const MISSING_MODEL_COLOR = '#ff0044';

const loader = new GLTFLoader();
const templates = new Map<string, Promise<Object3D>>();
const sharedMaterials = new Map<string, MeshLambertMaterial>();

/**
 * Kenney materials are PBR; without an environment map their metals render black.
 * Lambert keeps the flat, readable look and lets the palette shader do the styling.
 */
function toLambert(material: MeshStandardMaterial): MeshLambertMaterial {
  const key = `${material.name}:${material.color.getHexString()}`;
  let shared = sharedMaterials.get(key);
  if (!shared) {
    shared = new MeshLambertMaterial({ color: material.color.clone(), name: material.name });
    sharedMaterials.set(key, shared);
  }
  return shared;
}

/** Re-centers a model so its footprint is centered on the origin and it sits on y = 0. */
function normalize(model: Object3D): Group {
  const bounds = new Box3().setFromObject(model);
  const center = bounds.getCenter(new Vector3());
  model.position.set(-center.x, -bounds.min.y, -center.z);
  const wrapper = new Group();
  wrapper.add(model);
  return wrapper;
}

function prepare(model: Object3D): void {
  model.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    if (child.material instanceof MeshStandardMaterial) child.material = toLambert(child.material);
  });
}

function placeholder(): Group {
  const mesh = new Mesh(
    new BoxGeometry(0.5, 0.5, 0.5),
    new MeshLambertMaterial({ color: new Color(MISSING_MODEL_COLOR) }),
  );
  mesh.position.y = 0.25;
  const group = new Group();
  group.add(mesh);
  return group;
}

async function loadTemplate(name: string): Promise<Object3D> {
  try {
    const gltf = await loader.loadAsync(`${MODEL_ROOT}/${name}.glb`);
    prepare(gltf.scene);
    return normalize(gltf.scene);
  } catch (error) {
    // Keep the scene usable: a bright placeholder makes the missing model obvious.
    console.warn(`[assets] failed to load model "${name}"`, error);
    return placeholder();
  }
}

/** Returns a fresh instance of a Kenney model (geometry and materials are shared). */
export async function loadModel(name: string): Promise<Object3D> {
  let template = templates.get(name);
  if (!template) {
    template = loadTemplate(name);
    templates.set(name, template);
  }
  return (await template).clone(true);
}
