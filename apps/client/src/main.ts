import './style.css';
import { EnvelopeSchema } from '@harness/protocol';
import { Color, Scene, Vector3 } from 'three';
import { Choreographer } from './choreo/choreographer';
import { OfficeCamera } from './engine/officeCamera';
import { ENDESGA_32, createPaletteTexture } from './engine/palette';
import { PixelPipeline } from './engine/pixelPipeline';
import { NameTags } from './hud/nameTags';
import { MockRun } from './sim/mockRun';
import { WorldStore } from './state/world';
import { Crowd } from './world/crowd';
import { FRONT_DOOR_OUTSIDE, OFFICE_DEPTH, OFFICE_WIDTH } from './world/layout';
import { buildOffice } from './world/office';

const PIXELS_PER_UNIT = 32;
const MIN_PIXEL_SCALE = 2;
const DEFAULT_ZOOM_LEVEL = 2;
const MAX_ZOOM_LEVEL = 4;
/** Accumulated wheel delta per zoom step, so trackpads don't race through levels. */
const WHEEL_STEP = 50;
const PAN_SPEED = 6;
const MAX_FRAME_DT = 0.1;
const DOOR_OUTSIDE = new Vector3(FRONT_DOOR_OUTSIDE.x, 0, FRONT_DOOR_OUTSIDE.z);
/** True while the office is driven by the in-browser mock rather than real agents. */
const IS_SIMULATED = true;

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
const world = new WorldStore();

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

/** Run status comes straight from the world store (exact), not from the animation. */
function runStatusLines(): string[] {
  const { agents, tasks, inbox, totalCostUsd } = world.state;
  const done = [...tasks.values()].filter((task) => task.state === 'done').length;
  // The mock invents token usage; never let a fake number look like a real bill.
  const cost = `$${totalCostUsd.toFixed(2)}${IS_SIMULATED ? ' <span class="off">SIM</span>' : ''}`;
  const lines = [`AGENTS ${agents.size} · TASKS ${done}/${tasks.size} · ${cost}`];
  if (inbox.size > 0) lines.push(`<span class="alert">❗ ${inbox.size} WAITING ON YOU</span>`);
  return lines;
}

function renderHud(): void {
  const flag = (on: boolean) => (on ? 'ON' : '<span class="off">OFF</span>');
  const { palette, outline, dither } = pipeline.settings;
  hud.innerHTML = [
    'HARNESS · MOCK RUN',
    ...runStatusLines(),
    `<kbd>DRAG</kbd>/<kbd>WASD</kbd> PAN · <kbd>WHEEL</kbd>/<kbd>1-4</kbd> ZOOM ${zoomLevel}`,
    `<kbd>P</kbd> PALETTE ${flag(palette)} · <kbd>B</kbd> DITHER ${flag(dither)}`,
    `<kbd>O</kbd> OUTLINE ${flag(outline)} · <kbd>N</kbd> NAMES ${flag(nameTags.visible)}`,
    '<kbd>SPACE</kbd> CENTER',
  ].join('<br>');
}

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

  const crowd = new Crowd(office.grid);
  const choreographer = new Choreographer({ scene, crowd, spots: office.spots, overlay: nameTags, doorOutside: DOOR_OUTSIDE });

  // The feed is the system boundary: everything is validated before it touches state.
  const feed = new MockRun();
  feed.subscribe((raw) => {
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[feed] dropped invalid event', parsed.error.issues);
      return;
    }
    world.apply(parsed.data);
    choreographer.handle(parsed.data.event, world.state);
  });
  world.subscribe(renderHud);
  feed.start();

  const panInput = setupInput();
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    const time = now / 1000;

    const { right, forward } = panInput();
    officeCamera.pan(right * PAN_SPEED * dt, forward * PAN_SPEED * dt);
    officeCamera.update();

    crowd.update(dt);
    choreographer.update(dt, time);
    office.update(time);

    pipeline.render(scene, officeCamera.camera);
    nameTags.update(officeCamera.camera, canvas, dt);
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
