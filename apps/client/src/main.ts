import './style.css';
import { Color, Scene, Vector3 } from 'three';
import { Character, type CharacterLook } from './actors/character';
import { OfficeCamera } from './engine/officeCamera';
import { ENDESGA_32, createPaletteTexture } from './engine/palette';
import { PixelPipeline } from './engine/pixelPipeline';
import { NameTags } from './hud/nameTags';
import { Crowd } from './world/crowd';
import { FRONT_DOOR_OUTSIDE, OFFICE_DEPTH, OFFICE_WIDTH, type SpotDef } from './world/layout';
import { buildOffice } from './world/office';

const PIXELS_PER_UNIT = 32;
const MIN_PIXEL_SCALE = 2;
const DEFAULT_ZOOM_LEVEL = 2;
const MAX_ZOOM_LEVEL = 4;
/** Accumulated wheel delta per zoom step, so trackpads don't race through levels. */
const WHEEL_STEP = 50;
const PAN_SPEED = 6;
const MAX_FRAME_DT = 0.1;
const WORKER_COUNT = 8;
const SPAWN_INTERVAL_SECONDS = 1.1;
const DOOR_OUTSIDE = new Vector3(FRONT_DOOR_OUTSIDE.x, 0, FRONT_DOOR_OUTSIDE.z);

const WORKER_SHIRTS = ['#63c74d', '#e43b44', '#feae34', '#0099db', '#b55088', '#f77622', '#2ce8f5', '#c0cbdc'];
const WORKER_HAIR = ['#b86f50', '#3e2731', '#181425', '#feae34', '#733e39', '#e4a672'];
const WORKER_SKIN = ['#e4a672', '#e8b796', '#c28569', '#b86f50', '#733e39'];
const WORKER_PANTS = ['#5a6988', '#262b44', '#3a4466', '#733e39'];

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector} element`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#game');
const hud = requireElement<HTMLElement>('#hud');

const pipeline = new PixelPipeline(canvas, createPaletteTexture(ENDESGA_32), ENDESGA_32.length);
const officeCamera = new OfficeCamera({ pixelsPerUnit: PIXELS_PER_UNIT, yawDeg: 28, pitchDeg: 58, distance: 40 });
const officeCenter = new Vector3(OFFICE_WIDTH / 2, 0, OFFICE_DEPTH / 2);
officeCamera.target.copy(officeCenter);
officeCamera.setBounds(0, 0, OFFICE_WIDTH, OFFICE_DEPTH);

const scene = new Scene();
scene.background = new Color('#181425');
const nameTags = new NameTags(document.body);

/** Zoom level 1–4 maps to how many screen pixels each game pixel covers (2–5). */
let zoomLevel = DEFAULT_ZOOM_LEVEL;
let pixelScale = MIN_PIXEL_SCALE + zoomLevel - 1;

function resize(): void {
  pipeline.resize(window.innerWidth, window.innerHeight, pixelScale);
  officeCamera.setViewport(pipeline.size.x, pipeline.size.y);
}

function setZoom(level: number): void {
  const clamped = Math.min(MAX_ZOOM_LEVEL, Math.max(1, level));
  if (clamped === zoomLevel) return;
  zoomLevel = clamped;
  pixelScale = MIN_PIXEL_SCALE + zoomLevel - 1;
  resize();
  renderHud();
}

function renderHud(): void {
  const flag = (on: boolean) => (on ? 'ON' : '<span class="off">OFF</span>');
  const { palette, outline, dither } = pipeline.settings;
  hud.innerHTML = [
    'HARNESS · PHASE 1',
    `<kbd>DRAG</kbd>/<kbd>WASD</kbd> PAN · <kbd>WHEEL</kbd>/<kbd>1-4</kbd> ZOOM ${zoomLevel}`,
    `<kbd>P</kbd> PALETTE ${flag(palette)} · <kbd>B</kbd> DITHER ${flag(dither)}`,
    `<kbd>O</kbd> OUTLINE ${flag(outline)} · <kbd>N</kbd> NAMES ${flag(nameTags.visible)}`,
    '<kbd>SPACE</kbd> CENTER',
  ].join('<br>');
}

function workerLook(index: number): CharacterLook {
  const pick = (options: string[], salt: number) => options[(index * 7 + salt) % options.length];
  return {
    shirt: WORKER_SHIRTS[index % WORKER_SHIRTS.length],
    hair: pick(WORKER_HAIR, 1),
    skin: pick(WORKER_SKIN, 3),
    pants: pick(WORKER_PANTS, 2),
    shoes: '#262b44',
  };
}

const anchorOf = (spot: SpotDef) => new Vector3(spot.anchor.x, 0, spot.anchor.z);

function setupInput(): () => { right: number; forward: number } {
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    officeCamera.dragBy((event.clientX - drag.x) / pixelScale, (event.clientY - drag.y) / pixelScale);
    drag = { x: event.clientX, y: event.clientY };
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  let wheelAccumulator = 0;
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    wheelAccumulator += event.deltaY;
    if (Math.abs(wheelAccumulator) < WHEEL_STEP) return;
    // Scrolling up (negative delta) zooms in.
    setZoom(zoomLevel - Math.sign(wheelAccumulator));
    wheelAccumulator = 0;
  }, { passive: false });

  const pressed = new Set<string>();
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    pressed.add(key);
    if (key >= '1' && key <= String(MAX_ZOOM_LEVEL)) {
      setZoom(Number(key));
      return;
    } else if (key === 'p') pipeline.settings.palette = !pipeline.settings.palette;
    else if (key === 'o') pipeline.settings.outline = !pipeline.settings.outline;
    else if (key === 'b') pipeline.settings.dither = !pipeline.settings.dither;
    else if (key === 'n') nameTags.visible = !nameTags.visible;
    else if (key === ' ') officeCamera.target.copy(officeCenter);
    else return;
    renderHud();
  });
  window.addEventListener('keyup', (event) => pressed.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => pressed.clear());

  const axis = (positive: string[], negative: string[]) =>
    (positive.some((k) => pressed.has(k)) ? 1 : 0) - (negative.some((k) => pressed.has(k)) ? 1 : 0);
  return () => ({ right: axis(['d', 'arrowright'], ['a', 'arrowleft']), forward: axis(['w', 'arrowup'], ['s', 'arrowdown']) });
}

async function start(): Promise<void> {
  const office = await buildOffice();
  scene.add(office.group);

  const spot = (id: string) => {
    const found = office.spots.get(id);
    if (!found) throw new Error(`Unknown spot "${id}"`);
    return found;
  };
  const spots = [...office.spots.values()];

  const bossSpot = spot('boss');
  const boss = new Character({ shirt: '#ffffff', pants: '#262b44', skin: '#e8b796', hair: '#3e2731', shoes: '#181425', tie: '#e43b44' });
  boss.sit(anchorOf(bossSpot), bossSpot.heading, bossSpot.seatHeight, true);

  const boardSpot = spot('whiteboard');
  const architect = new Character({ shirt: '#124e89', pants: '#3a4466', skin: '#c28569', hair: '#181425', shoes: '#3e2731' });
  architect.stand(anchorOf(boardSpot), boardSpot.heading, 'draw');

  const crowd = new Crowd(office.grid, spots.filter((s) => s.kind === 'activity'));
  crowd.reserveStatic(bossSpot.tile, 'boss');
  crowd.reserveStatic(boardSpot.tile, 'architect');

  const characters = [boss, architect];
  scene.add(boss.root, architect.root);
  nameTags.add({ name: 'BOSS', subtitle: 'ORCHESTRATOR', role: 'boss', headPosition: (out) => boss.headPosition(out) });
  nameTags.add({ name: 'ARCHITECT', role: 'architect', headPosition: (out) => architect.headPosition(out) });

  // Workers arrive one at a time through the front door and head to their desks.
  const entrance = spot('entrance');
  const pendingDesks = spots.filter((s) => s.kind === 'desk').slice(0, WORKER_COUNT);
  let spawnTimer = 0;
  const spawnWorkers = (dt: number) => {
    spawnTimer -= dt;
    if (!pendingDesks.length || spawnTimer > 0 || !crowd.isTileFree(entrance.tile)) return;
    spawnTimer = SPAWN_INTERVAL_SECONDS;
    const index = characters.length - 2;
    const worker = new Character(workerLook(index));
    crowd.add(`worker-${index + 1}`, worker, entrance.tile, pendingDesks.shift()!, DOOR_OUTSIDE);
    characters.push(worker);
    scene.add(worker.root);
    nameTags.add({ name: `WORKER ${index + 1}`, role: 'worker', headPosition: (out) => worker.headPosition(out) });
  };

  const panInput = setupInput();
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    const time = now / 1000;

    const { right, forward } = panInput();
    officeCamera.pan(right * PAN_SPEED * dt, forward * PAN_SPEED * dt);
    officeCamera.update();

    spawnWorkers(dt);
    crowd.update(dt);
    for (const character of characters) character.update(dt, time);
    office.update(time);

    pipeline.render(scene, officeCamera.camera);
    nameTags.update(officeCamera.camera, canvas);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
renderHud();
start().catch((error: unknown) => {
  hud.textContent = `FAILED TO START: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
});
